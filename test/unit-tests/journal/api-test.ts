/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError, parseBoxStatus } from "../../../src/journal/api";
import { type BoxStatus, type DevicesResponse } from "../../../src/journal/types";

const fetchMock = jest.fn();

function jsonResponse(body: unknown, status = 200): Pick<Response, "status" | "headers" | "arrayBuffer"> {
    const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
    return {
        status,
        headers: new Headers({ "Content-Type": "application/json" }),
        arrayBuffer: async () => encoded.buffer,
    };
}

describe("JournalApi settings", () => {
    beforeEach(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("reads the full settings view", async () => {
        const view = { notices: true, auto_approve_coordinator_spawns: false };
        fetchMock.mockResolvedValue(jsonResponse(view));
        await expect(new JournalApi("https://journal.example", "token").settings()).resolves.toEqual(view);
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/settings");
        expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    });

    it.each([true, false])("patches spawn auto-approval to %s and returns the full view", async (enabled) => {
        const view = { notices: true, auto_approve_coordinator_spawns: enabled };
        fetchMock.mockResolvedValue(jsonResponse(view));
        await expect(
            new JournalApi("https://journal.example", "token").patchSettings({
                auto_approve_coordinator_spawns: enabled,
            }),
        ).resolves.toEqual(view);
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/settings");
        expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ auto_approve_coordinator_spawns: enabled });
    });
});

describe("JournalApi uploadMedia", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("sends the bytes and content type verbatim and returns a structurally valid media response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ media_id: "media-1", size: 3, content_type: "image/png" }));
        const api = new JournalApi("https://journal.example", "token");
        const bytes = new Uint8Array([1, 2, 3]).buffer;

        await expect(api.uploadMedia(bytes, "image/png")).resolves.toEqual({
            media_id: "media-1",
            size: 3,
            content_type: "image/png",
        });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/media");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    Authorization: "Bearer token",
                    "Content-Type": "image/png",
                }),
            }),
        );
        expect(fetchMock.mock.calls[0][1].body).toBe(bytes);
    });

    it.each([
        ["an object with no fields", {}],
        ["a null media id", { media_id: null, size: 3, content_type: "image/png" }],
        ["a blank media id", { media_id: "  ", size: 3, content_type: "image/png" }],
        ["a missing size", { media_id: "media-1", content_type: "image/png" }],
        ["a non-number size", { media_id: "media-1", size: "3", content_type: "image/png" }],
        ["a missing content type", { media_id: "media-1", size: 3 }],
        ["a non-string content type", { media_id: "media-1", size: 3, content_type: null }],
    ])("rejects a successful response containing %s", async (_description, body) => {
        fetchMock.mockResolvedValue(jsonResponse(body));
        const api = new JournalApi("https://journal.example", "token");

        const upload = api.uploadMedia(new ArrayBuffer(3), "image/png");

        await expect(upload).rejects.toBeInstanceOf(JournalApiError);
        await expect(upload).rejects.toMatchObject({ status: 200 });
    });

    it.each([
        [413, "too_large", "File too large."],
        [400, "empty", "That file is empty."],
    ])("maps HTTP %i code %s to prose", async (status, code, message) => {
        fetchMock.mockResolvedValue(jsonResponse({ error: code }, status));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.uploadMedia(new ArrayBuffer(1), "application/octet-stream")).rejects.toMatchObject({
            message,
            status,
            code,
        });
    });

    it("forwards the abort signal to fetch and rejects when it is aborted", async () => {
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener(
                        "abort",
                        () => reject(new DOMException("The operation was aborted.", "AbortError")),
                        { once: true },
                    );
                }),
        );
        const api = new JournalApi("https://journal.example", "token");
        const controller = new AbortController();

        const upload = api.uploadMedia(new ArrayBuffer(1), "application/octet-stream", controller.signal);
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: controller.signal }));
        controller.abort();

        await expect(upload).rejects.toMatchObject({ name: "Error", message: "The operation was aborted." });
    });

    it("rejects binary requests in Electron before issuing a POST", async () => {
        const journalRequest = jest.fn();
        (window as Window & { electron?: unknown }).electron = {
            initialise: jest.fn(),
            journalRequest,
        };
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.uploadMedia(new ArrayBuffer(1), "application/octet-stream")).rejects.toMatchObject({
            message: "Attachments aren't supported in the desktop build yet.",
            code: "electron_binary_unsupported",
        });
        expect(journalRequest).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("with upload progress", () => {
        // A scripted XMLHttpRequest: the test drives progress and the response by hand.
        class FakeXhr {
            public static last: FakeXhr | undefined;
            public method = "";
            public url = "";
            public headers: Record<string, string> = {};
            public body: unknown;
            public responseType = "";
            public status = 0;
            public response: ArrayBuffer | null = null;
            public responseHeaders = "";
            public aborted = false;
            public upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
            public onload: (() => void) | null = null;
            public onerror: (() => void) | null = null;
            public onabort: (() => void) | null = null;
            public constructor() {
                FakeXhr.last = this;
            }
            public open(method: string, url: string): void {
                this.method = method;
                this.url = url;
            }
            public setRequestHeader(name: string, value: string): void {
                this.headers[name] = value;
            }
            public getAllResponseHeaders(): string {
                return this.responseHeaders;
            }
            public send(body: unknown): void {
                this.body = body;
            }
            public abort(): void {
                this.aborted = true;
                this.onabort?.();
            }
            public progress(loaded: number, total: number): void {
                this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
            }
            public respond(status: number, body: unknown): void {
                this.status = status;
                this.responseHeaders = "content-type: application/json\r\n";
                this.response = new NodeTextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer;
                this.onload?.();
            }
        }
        const realXhr = globalThis.XMLHttpRequest;

        beforeEach(() => {
            FakeXhr.last = undefined;
            globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
        });

        afterEach(() => {
            globalThis.XMLHttpRequest = realXhr;
        });

        it("reports the uploaded fraction and resolves with the media response", async () => {
            const api = new JournalApi("https://journal.example", "token");
            const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
            const fractions: number[] = [];

            const upload = api.uploadMedia(bytes, "image/png", undefined, (fraction) => fractions.push(fraction));
            const xhr = FakeXhr.last!;
            expect(xhr.method).toBe("POST");
            expect(xhr.url).toBe("https://journal.example/media");
            expect(xhr.headers).toEqual(
                expect.objectContaining({ Authorization: "Bearer token", "Content-Type": "image/png" }),
            );
            expect(xhr.body).toBe(bytes);
            xhr.progress(1, 4);
            xhr.progress(4, 4);
            xhr.respond(200, { media_id: "media-1", size: 4, content_type: "image/png" });

            await expect(upload).resolves.toEqual({ media_id: "media-1", size: 4, content_type: "image/png" });
            expect(fractions).toEqual([0.25, 1]);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("maps an error status to the same prose as the fetch path", async () => {
            const api = new JournalApi("https://journal.example", "token");

            const upload = api.uploadMedia(new ArrayBuffer(1), "image/png", undefined, () => undefined);
            FakeXhr.last!.respond(413, { error: "too_large" });

            await expect(upload).rejects.toMatchObject({ message: "File too large.", status: 413, code: "too_large" });
        });

        it("aborts the request when the signal aborts", async () => {
            const api = new JournalApi("https://journal.example", "token");
            const controller = new AbortController();

            const upload = api.uploadMedia(new ArrayBuffer(1), "image/png", controller.signal, () => undefined);
            controller.abort();

            await expect(upload).rejects.toBeInstanceOf(JournalApiError);
            expect(FakeXhr.last!.aborted).toBe(true);
        });
    });
});

describe("JournalApi snapshot", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("forwards cancellation to the browser transport", async () => {
        let transportSignal: AbortSignal | undefined;
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    transportSignal = init.signal ?? undefined;
                    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                        once: true,
                    });
                }),
        );
        const api = new JournalApi("https://journal.example", "token");
        const controller = new AbortController();

        const snapshot = api.snapshot(controller.signal);
        controller.abort();

        await expect(snapshot).rejects.toMatchObject({ message: "aborted" });
        expect(transportSignal).toBe(controller.signal);
        expect(transportSignal?.aborted).toBe(true);
    });
});

describe("JournalApi devices", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        jest.useFakeTimers();
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("rejects a browser request that exceeds the transport-agnostic timeout", async () => {
        let requestSignal: AbortSignal | undefined;
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    requestSignal = init.signal ?? undefined;
                    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                        once: true,
                    });
                }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const devices = api.devices();
        jest.advanceTimersByTime(10_000);

        await expect(devices).rejects.toMatchObject({ message: "timeout", status: 0 });
        expect(requestSignal?.aborted).toBe(true);
    });

    it("shares a browser devices request between concurrent callers", async () => {
        let resolveRequest!: (response: ReturnType<typeof jsonResponse>) => void;
        fetchMock.mockReturnValue(
            new Promise((resolve) => {
                resolveRequest = resolve;
            }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const first = api.devices();
        const second = api.devices();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        resolveRequest(jsonResponse({ devices: [] }));

        await expect(first).resolves.toEqual({ devices: [] });
        await expect(second).resolves.toEqual({ devices: [] });
    });

    it("times out an Electron request and handles a late rejection from the losing branch", async () => {
        let rejectRequest!: (reason: Error) => void;
        const journalRequest = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<never>((_resolve, reject) => {
                        rejectRequest = reject;
                    }),
            )
            .mockResolvedValueOnce({
                status: 200,
                headers: { "Content-Type": "application/json" },
                body: new NodeTextEncoder().encode(JSON.stringify({ devices: [] })).buffer,
            });
        (window as Window & { electron?: unknown }).electron = {
            initialise: jest.fn(),
            journalRequest,
        };
        const api = new JournalApi("https://journal.example", "token");

        const devices = api.devices();
        jest.advanceTimersByTime(10_000);
        await expect(devices).rejects.toMatchObject({ message: "timeout", status: 0 });

        const retry = api.devices();
        expect(journalRequest).toHaveBeenCalledTimes(2);
        await expect(retry).resolves.toEqual({ devices: [] });

        rejectRequest(new Error("late desktop failure"));
        await Promise.resolve();
        expect(journalRequest).toHaveBeenCalledTimes(2);
    });

    it("drops malformed items when at least one roster item is valid", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                devices: [
                    { device_id: "wrong", kind: "agent", connected: true, is_self: false },
                    {
                        device_id: 7,
                        kind: "agent",
                        name: "Workstation",
                        last_seen_at: 123,
                        connected: true,
                        is_self: false,
                    },
                ],
            }),
        );
        const api = new JournalApi("https://journal.example", "token");
        const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(api.devices()).resolves.toEqual({
            devices: [
                {
                    device_id: 7,
                    kind: "agent",
                    name: "Workstation",
                    last_seen_at: 123,
                    connected: true,
                    is_self: false,
                },
            ],
        });
        expect(warning).toHaveBeenCalledWith("matron:devices", {
            event: "partial_roster",
            rejected_count: 1,
            reasons: [["invalid_device_id"]],
        });
    });

    it.each([
        ["a null envelope", null],
        ["an array envelope", []],
        ["a missing devices field", {}],
        ["a non-array devices field", { devices: null }],
    ])("throws a typed error for %s", async (_description, body) => {
        fetchMock.mockResolvedValue(jsonResponse(body));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.devices()).rejects.toBeInstanceOf(JournalApiError);
        await expect(api.devices()).rejects.toMatchObject({ status: 200 });
    });

    it("returns a genuinely empty roster", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ devices: [] }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.devices()).resolves.toEqual({ devices: [] });
    });

    it("throws when a nonempty roster has no valid items", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                devices: [
                    { device_id: "7", kind: "agent", connected: true, is_self: false },
                    { device_id: 8, kind: "agent", connected: "yes", is_self: false },
                ],
            }),
        );
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.devices()).rejects.toBeInstanceOf(JournalApiError);
    });

    it("returns a typed devices response on success", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                devices: [{ device_id: 7, kind: "agent", connected: false, is_self: false }],
            }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const response: DevicesResponse = await api.devices();

        expect(response.devices).toHaveLength(1);
        expect(response.devices[0]).toMatchObject({ device_id: 7, kind: "agent", connected: false });
    });
});

describe("JournalApi answerAgentSpawn", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("POSTs to /agent-spawn/answer with exactly request_id and decision — never always_allow", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
        const api = new JournalApi("https://journal.example", "token");

        await api.answerAgentSpawn("spawn-1", "approve");

        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/agent-spawn/answer");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    Authorization: "Bearer token",
                    "Content-Type": "application/json",
                }),
            }),
        );
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(["decision", "request_id"]);
        expect(body).toEqual({ request_id: "spawn-1", decision: "approve" });
    });

    it("sends deny verbatim as the decision", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
        const api = new JournalApi("https://journal.example", "token");

        await api.answerAgentSpawn("spawn-2", "deny");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
        expect(body).toEqual({ request_id: "spawn-2", decision: "deny" });
    });

    it("rejects with a typed 409 when the request was already resolved", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: "already_resolved" }, 409));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.answerAgentSpawn("spawn-1", "approve")).rejects.toMatchObject({ status: 409 });
    });

    it("rejects with a typed 404 when the request row is gone", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.answerAgentSpawn("spawn-1", "approve")).rejects.toMatchObject({ status: 404 });
    });

    it("rejects with a typed transport error when the network is unreachable", async () => {
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.answerAgentSpawn("spawn-1", "approve")).rejects.toMatchObject({ status: 0 });
    });
});

describe("JournalApi answerAgentChat", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("POSTs exactly room_id, target_device_id and decision to /agent-chat/answer", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true, delivered: true }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.answerAgentChat("room-1", 12, "deny")).resolves.toBe(true);

        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/agent-chat/answer");
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: "POST" }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
        expect(body).toEqual({ room_id: "room-1", target_device_id: 12, decision: "deny" });
    });

    it("reports an approval still owed to the target as not delivered", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.answerAgentChat("room-1", 12, "approve")).resolves.toBe(false);
    });

    it("rejects with a typed 409 when the ask is no longer awaiting an answer", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: "conflict" }, 409));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.answerAgentChat("room-1", 12, "approve")).rejects.toMatchObject({ status: 409 });
    });
});

describe("JournalApi messages", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(jsonResponse({ events: [] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("requests a window around a sequence without before_seq", async () => {
        const api = new JournalApi("https://journal.example", "token");

        await api.messages("convo-1", undefined, 80, 1234);

        expect(String(fetchMock.mock.calls[0][0])).toBe(
            "https://journal.example/convo/convo-1/messages?limit=80&around_seq=1234",
        );
    });

    it("requests messages before a sequence without around_seq", async () => {
        const api = new JournalApi("https://journal.example", "token");

        await api.messages("convo-1", 500, 80);

        expect(String(fetchMock.mock.calls[0][0])).toBe(
            "https://journal.example/convo/convo-1/messages?limit=80&before_seq=500",
        );
    });

    it("prefers around_seq and omits before_seq when both are provided", async () => {
        const api = new JournalApi("https://journal.example", "token");

        await api.messages("convo-1", 500, 80, 1234);

        expect(String(fetchMock.mock.calls[0][0])).toBe(
            "https://journal.example/convo/convo-1/messages?limit=80&around_seq=1234",
        );
    });
});

describe("JournalApi search", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("requests /search with the url-encoded query + limit and returns the hits", async () => {
        const hits = [
            {
                convo_id: "c1",
                title: "Deploy notes",
                seq: 42,
                ts: 1_700_000_000_000,
                sender: "agent:dev-a",
                snippet: "the **rollout** window",
                live: false,
            },
        ];
        fetchMock.mockResolvedValue(jsonResponse({ hits }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.search("roll out", 20)).resolves.toEqual({ hits });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/search?q=roll+out&limit=20");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({ Authorization: "Bearer token" }),
            }),
        );
    });

    it("forwards an abort signal", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ hits: [] }));
        const api = new JournalApi("https://journal.example", "token");
        const controller = new AbortController();

        await api.search("x", 20, controller.signal);
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: controller.signal }));
    });

    it("rejects with a typed 400 when the server rejects the query", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: "bad_request" }, 400));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.search("", 20)).rejects.toMatchObject({ status: 400 });
    });

    it("scopes find-in-chat to one conversation in the journal's newest-first mode", async () => {
        const hits = [{ convo_id: "c 1", seq: 9, ts: 1, sender: "user:alice" }];
        fetchMock.mockResolvedValue(jsonResponse({ hits }));
        const api = new JournalApi("https://journal.example", "token");
        const controller = new AbortController();

        await expect(api.searchConversation("c 1", "roll out", 500, controller.signal)).resolves.toEqual({ hits });
        expect(String(fetchMock.mock.calls[0][0])).toBe(
            "https://journal.example/search?q=roll+out&limit=500&mode=recent&convo_id=c+1",
        );
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: controller.signal }));
    });
});

// GET /devices `status` — the box's last capacity report (protocol.md "Box status"):
// `{reported_at, activity?, limits?, disk?, account?}`. Every block is optional and each is
// dropped on its own when malformed; the device row itself is never rejected over it.
describe("JournalApi devices box status", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    const FULL_STATUS = {
        reported_at: 1790543772640,
        activity: { live_sessions: 5, last_hour: [{ path: "/srv/app", sessions: 2 }] },
        limits: {
            as_of: 1790543772000,
            lines: [
                {
                    id: "session",
                    label: "Session",
                    percent: 13,
                    resets: "Sep 28 at 1:10am (Europe/London)",
                    resets_at: "2026-09-28T00:10:00.000Z",
                },
                { id: "week_all", label: "Week (all models)", percent: 22 },
            ],
        },
        disk: { free_bytes: 56908316672, total_bytes: 1979120929996 },
        account: { email: "alice@example.com" },
    };

    it("parses a full status into a typed BoxStatus on the device", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                devices: [
                    { device_id: 7, kind: "agent", name: "pine", connected: true, is_self: false, status: FULL_STATUS },
                ],
            }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const response = await api.devices();
        const expected: BoxStatus = FULL_STATUS;
        expect(response.devices[0].status).toEqual(expected);
    });

    it("keeps a device whose status is missing or not an object, with no status", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                devices: [
                    { device_id: 7, kind: "agent", connected: true, is_self: false },
                    { device_id: 8, kind: "agent", connected: true, is_self: false, status: "busy" },
                    { device_id: 9, kind: "agent", connected: true, is_self: false, status: [1] },
                ],
            }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const response = await api.devices();
        expect(response.devices).toHaveLength(3);
        for (const device of response.devices) expect(device.status).toBeUndefined();
    });

    it("drops the whole status when reported_at is missing or not a finite number", () => {
        expect(parseBoxStatus({ ...FULL_STATUS, reported_at: undefined })).toBeUndefined();
        expect(parseBoxStatus({ ...FULL_STATUS, reported_at: "yesterday" })).toBeUndefined();
        expect(parseBoxStatus({ ...FULL_STATUS, reported_at: Number.NaN })).toBeUndefined();
    });

    it("drops only the malformed block and keeps the rest", () => {
        const parsed = parseBoxStatus({
            ...FULL_STATUS,
            activity: { live_sessions: "many" },
            limits: { as_of: 1, lines: "none" },
            disk: { free_bytes: 10, total_bytes: 5 },
            account: { email: 42 },
        });
        expect(parsed).toEqual({ reported_at: FULL_STATUS.reported_at });
    });

    it("drops a malformed limits line but keeps the valid ones", () => {
        const parsed = parseBoxStatus({
            reported_at: 1,
            limits: {
                as_of: 1,
                lines: [
                    { id: "session", label: "Session", percent: 13, resets_at: 5 },
                    { id: "week_all", label: "Week (all models)", percent: "22" },
                    null,
                    { id: "week_fable", label: "Week (Fable)", percent: 24, resets: "Oct 1" },
                ],
            },
        });
        expect(parsed).toEqual({
            reported_at: 1,
            limits: {
                as_of: 1,
                lines: [
                    { id: "session", label: "Session", percent: 13 },
                    { id: "week_fable", label: "Week (Fable)", percent: 24, resets: "Oct 1" },
                ],
            },
        });
    });

    it("drops a limits block with no usable lines and a disk block with impossible numbers", () => {
        expect(parseBoxStatus({ reported_at: 1, limits: { as_of: 1, lines: [] } })).toEqual({ reported_at: 1 });
        expect(parseBoxStatus({ reported_at: 1, disk: { free_bytes: -1, total_bytes: 10 } })).toEqual({
            reported_at: 1,
        });
        expect(parseBoxStatus({ reported_at: 1, disk: { free_bytes: 0, total_bytes: 0 } })).toEqual({ reported_at: 1 });
    });

    it("ignores unknown fields at every level without throwing", () => {
        const parsed = parseBoxStatus({
            reported_at: 1,
            weather: "sunny",
            activity: { live_sessions: 0, last_hour: [], load: 0.4 },
            limits: { as_of: 1, lines: [{ id: "session", label: "Session", percent: 1, colour: "red" }], model: "x" },
            disk: { free_bytes: 1, total_bytes: 2, mount: "/" },
            account: { email: "a@b.c", plan: "max" },
        });
        expect(parsed).toEqual({
            reported_at: 1,
            activity: { live_sessions: 0, last_hour: [] },
            limits: { as_of: 1, lines: [{ id: "session", label: "Session", percent: 1 }] },
            disk: { free_bytes: 1, total_bytes: 2 },
            account: { email: "a@b.c" },
        });
    });

    it("tolerates a malformed last_hour by keeping live_sessions and the valid entries", () => {
        expect(
            parseBoxStatus({
                reported_at: 1,
                activity: { live_sessions: 2, last_hour: [{ path: "/a", sessions: 1 }, { path: 3 }, "x"] },
            }),
        ).toEqual({ reported_at: 1, activity: { live_sessions: 2, last_hour: [{ path: "/a", sessions: 1 }] } });
        expect(parseBoxStatus({ reported_at: 1, activity: { live_sessions: 2 } })).toEqual({
            reported_at: 1,
            activity: { live_sessions: 2, last_hour: [] },
        });
    });

    it("returns undefined for non-object input", () => {
        expect(parseBoxStatus(undefined)).toBeUndefined();
        expect(parseBoxStatus(null)).toBeUndefined();
        expect(parseBoxStatus("status")).toBeUndefined();
        expect(parseBoxStatus([])).toBeUndefined();
    });
});

describe("JournalApi defaults", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("GETs /defaults with the device token", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ default_model: "opus[1m]", default_effort: null }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.defaults()).resolves.toEqual({ default_model: "opus[1m]", default_effort: null });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/defaults");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({ Authorization: "Bearer token" }),
            }),
        );
    });

    it("PUTs exactly the keys given, null included, and returns the full new state", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ default_model: null, default_effort: "xhigh" }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.putDefaults({ default_model: null })).resolves.toEqual({
            default_model: null,
            default_effort: "xhigh",
        });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/defaults");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "PUT",
                headers: expect.objectContaining({ "Content-Type": "application/json" }),
            }),
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ default_model: null });
    });

    it.each([
        ["bad_model", "The journal did not accept that model."],
        ["bad_effort", "The journal did not accept that effort level."],
    ])("rejects a 400 %s with a readable message and the code", async (code, message) => {
        fetchMock.mockResolvedValue(jsonResponse({ error: code }, 400));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.putDefaults({ default_effort: "turbo" })).rejects.toMatchObject({
            status: 400,
            code,
            message,
        });
    });

    it("reads a missing or empty value as the box default", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ default_model: "" }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.defaults()).resolves.toEqual({ default_model: null, default_effort: null });
    });

    it.each([
        ["an array", []],
        ["a numeric model", { default_model: 4, default_effort: null }],
        ["an object effort", { default_model: null, default_effort: { level: "high" } }],
    ])("rejects %s as malformed", async (_label, body) => {
        fetchMock.mockResolvedValue(jsonResponse(body));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.defaults()).rejects.toBeInstanceOf(JournalApiError);
    });
});

describe("JournalApi box defaults", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        device_id: 7,
        kind: "agent",
        name: "elm",
        connected: true,
        is_self: false,
        ...over,
    });

    it("reads an agent box's defaults from GET /devices", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ devices: [device({ defaults: { agent: "codex", model: "gpt-5.1-codex", effort: null } })] }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const { devices } = await api.devices();
        expect(devices[0].defaults).toEqual({ agent: "codex", model: "gpt-5.1-codex", effort: null });
    });

    it("leaves defaults absent on an old journal, and drops a malformed block without rejecting the box", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ devices: [device(), device({ device_id: 8, defaults: { agent: 3 } })] }),
        );
        const api = new JournalApi("https://journal.example", "token");

        const { devices } = await api.devices();
        expect(devices.map((entry) => entry.device_id)).toEqual([7, 8]);
        expect("defaults" in devices[0]).toBe(false);
        expect("defaults" in devices[1]).toBe(false);
    });

    it("reads missing keys in a defaults block as unset", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ devices: [device({ defaults: { agent: "claude" } })] }));
        const api = new JournalApi("https://journal.example", "token");

        const { devices } = await api.devices();
        expect(devices[0].defaults).toEqual({ agent: "claude", model: null, effort: null });
    });

    it("PUTs exactly the keys given to /devices/:id/defaults and returns the full new state", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ device_id: 7, default_agent: "codex", default_model: null, default_effort: "high" }),
        );
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.putBoxDefaults(7, { default_agent: "codex" })).resolves.toEqual({
            device_id: 7,
            default_agent: "codex",
            default_model: null,
            default_effort: "high",
        });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/devices/7/defaults");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "PUT",
                headers: expect.objectContaining({ Authorization: "Bearer token" }),
            }),
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ default_agent: "codex" });
    });

    it("PUTs only {consent} to /coordinator, never the conversation", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ convo_id: "c9", consent: false }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.putCoordinatorConsent(false)).resolves.toEqual({ convo_id: "c9", consent: false });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/coordinator");
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: "PUT" }));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ consent: false });
    });

    it.each([
        ["bad_agent", "The journal did not accept that agent."],
        ["bad_model", "The journal did not accept that model."],
        ["bad_effort", "The journal did not accept that effort level."],
        ["not_agent_device", "That device is not an agent box."],
    ])("rejects a 400 %s with a readable message and the code", async (code, message) => {
        fetchMock.mockResolvedValue(jsonResponse({ error: code }, 400));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.putBoxDefaults(7, { default_model: "?" })).rejects.toMatchObject({
            status: 400,
            code,
            message,
        });
    });

    it("rejects a malformed answer", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ device_id: 7, default_agent: 5 }));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.putBoxDefaults(7, { default_agent: null })).rejects.toBeInstanceOf(JournalApiError);
    });
});

describe("JournalApi project filing", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    const sent = (): { url: string; init: RequestInit; body: Record<string, unknown> } => ({
        url: String(fetchMock.mock.calls[0][0]),
        init: fetchMock.mock.calls[0][1] as RequestInit,
        body: JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>,
    });

    it("creates a project with a title, an optional body and an Idempotency-Key", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ project: { id: "pj_1", num: 7 } }, 201));
        const api = new JournalApi("https://journal.example", "token");

        const out = await api.createProject({ title: "Launch", body: "The spring launch" }, "key-1");

        const { url, init, body } = sent();
        expect(url).toBe("https://journal.example/projects");
        expect(init).toEqual(
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ "Idempotency-Key": "key-1" }),
            }),
        );
        expect(body).toEqual({ title: "Launch", body: "The spring launch" });
        expect(out.project.num).toBe(7);
    });

    it("leaves a blank body out of the create", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ project: { id: "pj_1", num: 7 } }, 201));
        const api = new JournalApi("https://journal.example", "token");

        await api.createProject({ title: "Launch", body: "   " }, "key-1");

        expect(sent().body).toEqual({ title: "Launch" });
    });

    it("merges a project into another by POST /projects/:id/merge with only `into`", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ project: { id: "pj_2" }, merged: { id: "pj_1" } }));
        const api = new JournalApi("https://journal.example", "token");

        await api.mergeProject("pj_1", "pj_2");

        const { url, init, body } = sent();
        expect(url).toBe("https://journal.example/projects/pj_1/merge");
        expect(init.method).toBe("POST");
        expect(body).toEqual({ into: "pj_2" });
    });

    it("moves a mission by PATCHing its project", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ mission: { id: "ms_1" } }));
        const api = new JournalApi("https://journal.example", "token");

        await api.patchMission("ms_1", { project: "pj_2" }, "key-2");

        const { url, init, body } = sent();
        expect(url).toBe("https://journal.example/missions/ms_1");
        expect(init.method).toBe("PATCH");
        expect(body).toEqual({ project: "pj_2" });
    });
});
