/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApiError } from "../../../src/journal/api";
import { MatronJournalClient } from "../../../src/journal/client";
import type { ClientState } from "../../../src/journal/types";

interface Internals {
    state: ClientState;
    api?: { lookup: jest.Mock };
}

function makeClient(lookup: jest.Mock): MatronJournalClient {
    const client = new MatronJournalClient();
    const inner = client as unknown as Internals;
    inner.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 1, username: "alice" },
    };
    inner.api = { lookup };
    return client;
}

describe("MatronJournalClient.trackerLinkInfo", () => {
    it("looks a link up under the user it names, or the signed-in user for an own-number link", async () => {
        const lookup = jest.fn().mockResolvedValue({ kind: "item", id: "it_1", num: 12, title: "Ship it" });
        const client = makeClient(lookup);

        expect(await client.trackerLinkInfo(null, 12)).toEqual({
            status: "found",
            hit: { kind: "item", id: "it_1", num: 12, title: "Ship it" },
        });
        expect(lookup).toHaveBeenLastCalledWith("alice", 12, undefined);

        await client.trackerLinkInfo("bob", 3);
        expect(lookup).toHaveBeenLastCalledWith("bob", 3, undefined);
    });

    it("asks the journal once for many links to the same number", async () => {
        const lookup = jest.fn().mockResolvedValue({ kind: "mission", id: "ms_1", num: 7, title: "Rota" });
        const client = makeClient(lookup);

        await Promise.all([client.trackerLinkInfo(null, 7), client.trackerLinkInfo("alice", 7)]);
        await client.trackerLinkInfo(null, 7);

        expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("keeps only found answers: a missing number or a failure is asked about again", async () => {
        const lookup = jest
            .fn()
            .mockRejectedValueOnce(new JournalApiError("not_found", 404, "not_found"))
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue({ kind: "item", id: "it_2", num: 2, title: "Two" });
        const client = makeClient(lookup);

        expect(await client.trackerLinkInfo(null, 2)).toEqual({ status: "none" });
        expect(await client.trackerLinkInfo(null, 2)).toEqual({ status: "failed" });
        const found = { status: "found", hit: { kind: "item", id: "it_2", num: 2, title: "Two" } };
        expect(await client.trackerLinkInfo(null, 2)).toEqual(found);
        expect(await client.trackerLinkInfo(null, 2)).toEqual(found);
        expect(lookup).toHaveBeenCalledTimes(3);
    });

    it("refuses a number that is not a tracker number without asking", async () => {
        const lookup = jest.fn();
        const client = makeClient(lookup);
        expect(await client.trackerLinkInfo(null, 0)).toEqual({ status: "failed" });
        expect(lookup).not.toHaveBeenCalled();
    });
});
