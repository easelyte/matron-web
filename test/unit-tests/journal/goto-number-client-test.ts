/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../../../src/journal/api";
import { MatronJournalClient, NUMBER_LOOKUP_TIMEOUT_MS } from "../../../src/journal/client";
import type { ClientState } from "../../../src/journal/types";

interface Internals {
    state: ClientState;
    api?: { lookup: jest.Mock };
}

function makeClient(lookup: jest.Mock, overrides: Partial<ClientState> = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    const inner = client as unknown as Internals;
    inner.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 1, username: "alice" },
        ...overrides,
    };
    inner.api = { lookup };
    return client;
}

describe("JournalApi.lookup", () => {
    it("GETs /lookup with the user and number", async () => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
        const encoded = new NodeTextEncoder().encode(JSON.stringify({ kind: "item", id: "it_1" }));
        const fetchMock = jest.fn().mockResolvedValue({
            status: 200,
            headers: new Headers({ "Content-Type": "application/json" }),
            arrayBuffer: async () => encoded.buffer,
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;

        const hit = await new JournalApi("https://journal.example", "token").lookup("alice b", 412);

        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/lookup?user=alice+b&num=412");
        expect(fetchMock.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: "Bearer token" }));
        expect(hit).toEqual({ kind: "item", id: "it_1" });
    });
});

describe("MatronJournalClient go to number", () => {
    it("looks the number up under the signed-in user's name and keeps only known fields", async () => {
        const lookup = jest.fn().mockResolvedValue({
            kind: "milestone",
            id: "ml_1",
            num: 412,
            title: "First draft",
            mission: { id: "ms_1", num: 7 },
            owner: { user_id: 1, name: "alice" },
        });
        const client = makeClient(lookup);

        const outcome = await client.lookupNumber(412);

        expect(lookup).toHaveBeenCalledWith("alice", 412, undefined);
        expect(outcome).toEqual({
            status: "found",
            hit: { kind: "milestone", id: "ml_1", num: 412, title: "First draft", mission: { id: "ms_1", num: 7 } },
        });
    });

    it("accepts an older journal's answer with no number or title", async () => {
        const client = makeClient(jest.fn().mockResolvedValue({ kind: "project", id: "pj_1" }));
        expect(await client.lookupNumber(9)).toEqual({ status: "found", hit: { kind: "project", id: "pj_1" } });
    });

    it("a 404 is none; any other failure, an unknown kind or a bad number is failed", async () => {
        const notFound = makeClient(jest.fn().mockRejectedValue(new JournalApiError("not_found", 404)));
        expect(await notFound.lookupNumber(412)).toEqual({ status: "none" });

        const down = makeClient(jest.fn().mockRejectedValue(new JournalApiError("timeout", 0)));
        expect(await down.lookupNumber(412)).toEqual({ status: "failed" });

        const odd = makeClient(jest.fn().mockResolvedValue({ kind: "memory", id: "x" }));
        expect(await odd.lookupNumber(412)).toEqual({ status: "failed" });

        const lookup = jest.fn();
        const client = makeClient(lookup);
        expect(await client.lookupNumber(0)).toEqual({ status: "failed" });
        expect(await client.lookupNumber(1.5)).toEqual({ status: "failed" });
        expect(lookup).not.toHaveBeenCalled();
    });

    it("gives up on a journal that never answers", async () => {
        jest.useFakeTimers();
        try {
            const client = makeClient(jest.fn().mockReturnValue(new Promise(() => undefined)));
            const outcome = client.lookupNumber(412);
            jest.advanceTimersByTime(NUMBER_LOOKUP_TIMEOUT_MS);
            expect(await outcome).toEqual({ status: "failed" });
        } finally {
            jest.useRealTimers();
        }
    });

    it("opens each kind in its own view; a milestone opens its mission", () => {
        const client = makeClient(jest.fn());

        expect(client.openNumberHit({ kind: "item", id: "it_1", num: 412 }, 412)).toBe(true);
        expect(client.getSnapshot().trackerView).toEqual(
            expect.objectContaining({ open: true, view: "inbox", selectedItemId: 412 }),
        );

        expect(client.openNumberHit({ kind: "mission", id: "ms_1", num: 7 }, 7)).toBe(true);
        expect(client.getSnapshot().trackerView).toEqual(
            expect.objectContaining({ view: "missions", selectedMissionId: 7, selectedItemId: undefined }),
        );

        expect(
            client.openNumberHit({ kind: "milestone", id: "ml_1", num: 8, mission: { id: "ms_2", num: 3 } }, 8),
        ).toBe(true);
        expect(client.getSnapshot().trackerView).toEqual(expect.objectContaining({ selectedMissionId: 3 }));

        // A merged project answers with the surviving project's number; an older journal with none.
        expect(client.openNumberHit({ kind: "project", id: "pj_2", num: 20 }, 15)).toBe(true);
        expect(client.getSnapshot().trackerView).toEqual(expect.objectContaining({ selectedProjectId: 20 }));
        expect(client.openNumberHit({ kind: "project", id: "pj_3" }, 15)).toBe(true);
        expect(client.getSnapshot().trackerView).toEqual(expect.objectContaining({ selectedProjectId: 15 }));
    });

    it("a milestone with no readable mission opens nothing", () => {
        const client = makeClient(jest.fn());
        expect(client.openNumberHit({ kind: "milestone", id: "ml_1", num: 8 }, 8)).toBe(false);
        expect(client.getSnapshot().trackerView).toBeUndefined();
    });

    it("opens and closes the field", () => {
        const client = makeClient(jest.fn());
        client.openGoToNumber();
        expect(client.getSnapshot().goToNumberOpen).toBe(true);
        client.closeGoToNumber();
        expect(client.getSnapshot().goToNumberOpen).toBe(false);
    });
});
