/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { JournalApi, JournalApiError } from "../../../src/journal/api";
import { MatronJournalClient, sanitizeBriefingLatest } from "../../../src/journal/client";
import { EventContent } from "../../../src/journal/components";
import type { BriefingLatest, ClientState, JournalEvent, ServerFrame } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function latest(over: Partial<BriefingLatest> = {}): BriefingLatest {
    return {
        briefing: { id: "br_1", body: "Hello", created_at: NOW - 1_000, convo_id: "c_coord", seq: 9 },
        refresh: null,
        next_refresh_at: null,
        has_coordinator: true,
        ...over,
    };
}

interface ApiMock {
    latestBriefing: jest.Mock;
    refreshBriefing: jest.Mock;
}

interface Internals {
    state: ClientState;
    api?: ApiMock;
    handleFrame(frame: ServerFrame): Promise<void>;
    handleReady(): Promise<void>;
    database?: unknown;
    connection?: unknown;
}

function makeClient(overrides: Partial<ClientState> = {}): { client: MatronJournalClient; internals: Internals } {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = { ...client.getSnapshot(), phase: "signed-in", ...overrides };
    internals.api = { latestBriefing: jest.fn(), refreshBriefing: jest.fn() };
    return { client, internals };
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("MatronJournalClient briefing loads", () => {
    it("loadBriefing stores the latest view", async () => {
        const { client, internals } = makeClient();
        internals.api!.latestBriefing.mockResolvedValue(latest());

        await client.loadBriefing();

        expect(client.getSnapshot().briefing).toMatchObject({ loading: false, unsupported: false, latest: latest() });
    });

    it("treats a 404 as a journal without briefings: unsupported, no error", async () => {
        const { client, internals } = makeClient();
        internals.api!.latestBriefing.mockRejectedValue(new JournalApiError("Not found", 404, "not_found"));

        await client.loadBriefing();

        expect(client.getSnapshot().briefing).toMatchObject({ unsupported: true, loading: false, error: undefined });
    });

    it("keeps a loaded view and records the error when a refetch fails", async () => {
        const { client, internals } = makeClient();
        internals.api!.latestBriefing.mockResolvedValueOnce(latest());
        await client.loadBriefing();
        internals.api!.latestBriefing.mockRejectedValueOnce(new JournalApiError("offline", 0));
        await client.loadBriefing();

        expect(client.getSnapshot().briefing).toMatchObject({ latest: latest(), error: "offline" });
    });

    it("ignores a superseded load", async () => {
        const { client, internals } = makeClient();
        let resolveFirst!: (value: BriefingLatest) => void;
        internals
            .api!.latestBriefing.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce(latest({ next_refresh_at: 5 }));
        const first = client.loadBriefing();
        await client.loadBriefing();
        resolveFirst(latest({ briefing: null }));
        await first;

        expect(client.getSnapshot().briefing?.latest?.next_refresh_at).toBe(5);
    });

    it("binds a malformed body defensively", () => {
        expect(
            sanitizeBriefingLatest({
                briefing: { id: 1 },
                refresh: { state: "weird", requested_at: 1 },
                next_refresh_at: "soon",
                has_coordinator: "yes",
            }),
        ).toEqual({ briefing: null, refresh: null, next_refresh_at: null, has_coordinator: false });
        expect(() => sanitizeBriefingLatest(null)).toThrow();
    });
});

describe("MatronJournalClient briefing refresh", () => {
    it("stores the 202 view", async () => {
        const { client, internals } = makeClient();
        const pending = latest({
            refresh: { requested_at: NOW, state: "pending", expires_at: NOW + 600_000 },
            next_refresh_at: NOW + 600_000,
        });
        internals.api!.refreshBriefing.mockResolvedValue(pending);

        await expect(client.requestBriefingRefresh()).resolves.toBe(true);

        expect(internals.api!.refreshBriefing).toHaveBeenCalledTimes(1);
        expect(client.getSnapshot().briefing).toMatchObject({ requesting: false, latest: pending });
    });

    it("records retry_at on a 429", async () => {
        const { client, internals } = makeClient({
            briefing: { loading: false, unsupported: false, latest: latest() },
        });
        internals.api!.refreshBriefing.mockRejectedValue(
            new JournalApiError("rate limited", 429, "rate_limited", undefined, {
                error: "rate_limited",
                retry_at: NOW + 120_000,
            }),
        );

        await expect(client.requestBriefingRefresh()).resolves.toBe(false);

        expect(client.getSnapshot().briefing).toMatchObject({
            requesting: false,
            retryAt: NOW + 120_000,
            refreshError: undefined,
            latest: latest(),
        });
    });

    it("says there is no Coordinator on a 409 and refetches", async () => {
        const { client, internals } = makeClient();
        internals.api!.refreshBriefing.mockRejectedValue(
            new JournalApiError("conflict", 409, "conflict", undefined, { blocked_by: "no_coordinator" }),
        );
        internals.api!.latestBriefing.mockResolvedValue(latest({ has_coordinator: false }));

        await client.requestBriefingRefresh();
        await flush();

        expect(client.getSnapshot().briefing?.refreshError).toBe("There's no Coordinator to ask.");
        expect(internals.api!.latestBriefing).toHaveBeenCalledTimes(1);
        expect(client.getSnapshot().briefing?.latest?.has_coordinator).toBe(false);
    });

    it("a later successful load clears a refused ask's message but keeps the 429 retry time", async () => {
        const { client, internals } = makeClient({
            briefing: {
                loading: false,
                unsupported: false,
                latest: latest(),
                refreshError: "The Coordinator is busy. Try again in a moment.",
                retryAt: NOW + 60_000,
            },
        });
        internals.api!.latestBriefing.mockResolvedValue(latest());

        await client.loadBriefing();

        expect(client.getSnapshot().briefing?.refreshError).toBeUndefined();
        expect(client.getSnapshot().briefing?.retryAt).toBe(NOW + 60_000);
    });

    it("says the Coordinator is busy on a 503", async () => {
        const { client, internals } = makeClient();
        internals.api!.refreshBriefing.mockRejectedValue(new JournalApiError("busy", 503, "busy"));

        await client.requestBriefingRefresh();

        expect(client.getSnapshot().briefing?.refreshError).toBe("The Coordinator is busy. Try again in a moment.");
    });

    it("refetches once a pending refresh's expires_at passes", async () => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        try {
            const { client, internals } = makeClient({ trackerView: { open: true, view: "missions" } });
            internals.api!.refreshBriefing.mockResolvedValue(
                latest({ refresh: { requested_at: NOW, state: "pending", expires_at: NOW + 600_000 } }),
            );
            internals.api!.latestBriefing.mockResolvedValue(
                latest({ refresh: { requested_at: NOW, state: "timed_out" } }),
            );
            await client.requestBriefingRefresh();

            jest.advanceTimersByTime(599_000);
            expect(internals.api!.latestBriefing).not.toHaveBeenCalled();
            jest.advanceTimersByTime(2_500);
            await flush();
            expect(internals.api!.latestBriefing).toHaveBeenCalledTimes(1);
            expect(client.getSnapshot().briefing?.latest?.refresh?.state).toBe("timed_out");
        } finally {
            jest.useRealTimers();
        }
    });
});

describe("MatronJournalClient briefing live frame", () => {
    it("refetches on a briefing frame while the card is loaded on an open pane", async () => {
        const { internals } = makeClient({
            trackerView: { open: true, view: "missions" },
            briefing: { loading: false, unsupported: false, latest: latest() },
        });
        internals.api!.latestBriefing.mockResolvedValue(latest({ briefing: null }));

        await internals.handleFrame({ kind: "briefing", action: "published", briefing_id: "br_2" });
        await flush();

        expect(internals.api!.latestBriefing).toHaveBeenCalledTimes(1);
        expect(internals.state.briefing?.latest?.briefing).toBeNull();
    });

    it("fetches nothing when the pane is closed or the journal lacks briefings", async () => {
        const closed = makeClient({ briefing: { loading: false, unsupported: false, latest: latest() } });
        await closed.internals.handleFrame({ kind: "briefing", action: "refreshing" });
        const unsupported = makeClient({
            trackerView: { open: true, view: "missions" },
            briefing: { loading: false, unsupported: true },
        });
        await unsupported.internals.handleFrame({ kind: "briefing", action: "refresh_failed" });

        expect(closed.internals.api!.latestBriefing).not.toHaveBeenCalled();
        expect(unsupported.internals.api!.latestBriefing).not.toHaveBeenCalled();
    });

    it("refetches on reconnect", async () => {
        const { internals } = makeClient({
            trackerView: { open: true, view: "missions" },
            briefing: { loading: false, unsupported: false, latest: latest() },
        });
        internals.api!.latestBriefing.mockResolvedValue(latest());
        internals.database = {
            outbox: jest.fn().mockResolvedValue([]),
            deleteOutboxRows: jest.fn(),
            cursor: jest.fn().mockResolvedValue(undefined),
        };
        internals.connection = { send: jest.fn() };

        await internals.handleReady();

        expect(internals.api!.latestBriefing).toHaveBeenCalledTimes(1);
    });
});

describe("MatronJournalClient briefing navigation + links", () => {
    it("openBriefing opens it in the missions view; a tab switch or closeBriefing closes it", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "missions", selectedMissionId: 3 } });

        client.openBriefing();
        expect(client.getSnapshot().trackerView).toMatchObject({ view: "missions", briefingOpen: true });
        expect(client.getSnapshot().trackerView?.selectedMissionId).toBeUndefined();

        client.openTrackerView({ view: "missions" });
        expect(client.getSnapshot().trackerView?.briefingOpen).toBe(true);
        client.openTrackerView({ view: "missions", itemId: null, missionId: null, memoryName: null });
        expect(client.getSnapshot().trackerView?.briefingOpen).toBeUndefined();

        client.openBriefing();
        client.closeBriefing();
        expect(client.getSnapshot().trackerView?.briefingOpen).toBeUndefined();

        client.openBriefing();
        client.openTrackerMission(4);
        expect(client.getSnapshot().trackerView).toMatchObject({ selectedMissionId: 4 });
        expect(client.getSnapshot().trackerView?.briefingOpen).toBeUndefined();
    });

    it("opening a project closes the briefing, and opening the briefing closes the project", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "missions" } });

        client.openBriefing();
        client.openTrackerProject(6);
        expect(client.getSnapshot().trackerView).toMatchObject({ view: "missions", selectedProjectId: 6 });
        expect(client.getSnapshot().trackerView?.briefingOpen).toBeUndefined();

        client.openBriefing();
        expect(client.getSnapshot().trackerView?.briefingOpen).toBe(true);
        expect(client.getSnapshot().trackerView?.selectedProjectId).toBeUndefined();

        // A matron://project link inside the open briefing lands on that project's page.
        client.openTrackerLink("project", 8);
        expect(client.getSnapshot().trackerView).toMatchObject({ view: "missions", selectedProjectId: 8 });
        expect(client.getSnapshot().trackerView?.briefingOpen).toBeUndefined();

        // An item opened from the project keeps the project for Back, and the briefing stays shut.
        client.openBriefing();
        client.openTrackerItem(3, { keepProject: true });
        expect(client.getSnapshot().trackerView?.briefingOpen).toBeUndefined();
    });

    it("openTrackerLink opens a conversation for matron://convo and the project page for matron://project", () => {
        const { client } = makeClient({ trackerView: { open: true, view: "inbox", selectedItemId: 2 } });
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);

        client.openTrackerLink("convo", "c_deploy");
        expect(select).toHaveBeenCalledWith("c_deploy", { suppressNotFound: true });

        client.openTrackerLink("project", 2);
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "missions", selectedProjectId: 2 });
        expect(client.getSnapshot().trackerView?.selectedItemId).toBeUndefined();

        client.openTrackerLink("mission", 5);
        expect(client.getSnapshot().trackerView?.selectedMissionId).toBe(5);
    });

    it("openBriefingInChat opens the Coordinator conversation", () => {
        const { client } = makeClient();
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);

        client.openBriefingInChat("c_coord");

        expect(select).toHaveBeenCalledWith("c_coord", { suppressNotFound: true });
    });

    it("openBriefingInChat lands on the briefing's own message when its seq is known", () => {
        const { client } = makeClient();
        const focus = jest.spyOn(client, "focusMessage").mockResolvedValue(true);

        client.openBriefingInChat("c_coord", 812);

        expect(focus).toHaveBeenCalledWith("c_coord", 812);
    });
});

describe("JournalApi briefing routes", () => {
    const fetchMock = jest.fn();
    const respond = (body: unknown, status: number): Pick<Response, "status" | "headers" | "arrayBuffer"> => {
        const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
        return { status, headers: new Headers(), arrayBuffer: async () => encoded.buffer };
    };

    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("GETs /briefings/latest and POSTs /briefings/refresh", async () => {
        fetchMock.mockResolvedValue(respond(latest(), 200));
        const api = new JournalApi("https://journal.example", "token");

        await expect(api.latestBriefing()).resolves.toEqual(latest());
        await api.refreshBriefing();

        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/briefings/latest");
        expect(fetchMock.mock.calls[0][1].method).toBe("GET");
        expect(String(fetchMock.mock.calls[1][0])).toBe("https://journal.example/briefings/refresh");
        expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    });

    it("carries the error body (retry_at) on a 429", async () => {
        fetchMock.mockResolvedValue(respond({ error: "rate_limited", retry_at: 1234 }, 429));
        const api = new JournalApi("https://journal.example", "token");

        const error = (await api.refreshBriefing().catch((e: unknown) => e)) as JournalApiError;

        expect(error).toBeInstanceOf(JournalApiError);
        expect(error.status).toBe(429);
        expect(error.body).toEqual({ error: "rate_limited", retry_at: 1234 });
    });
});

describe("Briefing badge in the timeline", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    const textEvent = (payload: Record<string, unknown>): JournalEvent => ({
        kind: "journal",
        seq: 9,
        convo_id: "c_coord",
        ts: NOW,
        sender: "agent:1",
        type: "text",
        payload: { body: "Morning sweep", from: "assistant", ...payload },
    });

    it("tags a text event carrying payload.briefing_id, and only that one", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const client = { openTrackerLink: jest.fn() } as unknown as MatronJournalClient;
        const props = { client, answeredPromptReplies: new Map() };

        await act(async () =>
            root.render(React.createElement(EventContent, { ...props, event: textEvent({ briefing_id: "br_1" }) })),
        );
        expect(container.querySelector(".mj_BriefingBadge")?.textContent).toBe("Briefing");

        await act(async () => root.render(React.createElement(EventContent, { ...props, event: textEvent({}) })));
        expect(container.querySelector(".mj_BriefingBadge")).toBeNull();

        await act(async () => root.unmount());
        container.remove();
    });
});
