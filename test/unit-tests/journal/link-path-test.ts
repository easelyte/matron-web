/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApiError } from "../../../src/journal/api";
import { MatronJournalClient } from "../../../src/journal/client";
import { othersLinkMessage, parseOwnTrackerUrl, parseTrackerLinkPath } from "../../../src/journal/link-path";
import type { ClientState } from "../../../src/journal/types";

interface Internals {
    state: ClientState;
    api?: { lookup: jest.Mock };
}

/** A client constructed while the page sits at `path`, signed in as `username`. */
function clientAt(path: string, lookup: jest.Mock, username = "alice"): MatronJournalClient {
    window.history.replaceState(null, "", path);
    const client = new MatronJournalClient();
    const inner = client as unknown as Internals;
    inner.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 1, username },
    };
    inner.api = { lookup };
    return client;
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("parseTrackerLinkPath", () => {
    it("reads the user and number from /u/<name>/<n>", () => {
        expect(parseTrackerLinkPath("/u/alice/412")).toEqual({ user: "alice", num: 412 });
        expect(parseTrackerLinkPath("/u/alice/412/")).toEqual({ user: "alice", num: 412 });
        expect(parseTrackerLinkPath("/u/alice%20b/7")).toEqual({ user: "alice b", num: 7 });
        expect(parseTrackerLinkPath("/chat/u/alice/7")).toEqual({ user: "alice", num: 7 });
    });

    it("ignores every other path", () => {
        for (const path of [
            "/",
            "/app/",
            "/u/alice",
            "/u/alice/0",
            "/u/alice/12x",
            "/u/alice/1/2",
            "/u//3",
            "/u/%E0/3",
        ]) {
            expect(parseTrackerLinkPath(path)).toBeNull();
        }
    });
});

describe("MatronJournalClient.openPathLink", () => {
    it("opens what the link's number names, once", async () => {
        const hit = { kind: "mission", id: "ms_1", num: 412 };
        const lookup = jest.fn().mockResolvedValue(hit);
        const client = clientAt("/u/alice/412", lookup);
        const open = jest.spyOn(client, "openNumberHit").mockReturnValue(true);

        await client.openPathLink();
        await client.openPathLink();

        expect(lookup).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledWith("alice", 412, undefined);
        expect(open).toHaveBeenCalledWith(hit, 412);
        expect(client.getSnapshot().controlError).toBeUndefined();
    });

    it("matches the user name without regard to case", async () => {
        const lookup = jest.fn().mockResolvedValue({ kind: "item", id: "it_1", num: 5 });
        const client = clientAt("/u/Alice/5", lookup);
        jest.spyOn(client, "openNumberHit").mockReturnValue(true);
        await client.openPathLink();
        expect(lookup).toHaveBeenCalledWith("alice", 5, undefined);
    });

    it("says another user's link can't be shown here, without looking it up", async () => {
        const lookup = jest.fn();
        const client = clientAt("/u/bob/5", lookup);
        await client.openPathLink();
        expect(lookup).not.toHaveBeenCalled();
        expect(client.getSnapshot().controlError).toBe(othersLinkMessage({ user: "bob", num: 5 }));
        expect(othersLinkMessage({ user: "bob", num: 5 })).toMatch(/^#5 is on bob's tracker\./);
    });

    it("does nothing on a page that is not a link", async () => {
        const lookup = jest.fn();
        await clientAt("/app/", lookup).openPathLink();
        expect(lookup).not.toHaveBeenCalled();
    });

    it("says so when the number names nothing, or the journal can't be asked", async () => {
        const none = clientAt("/u/alice/9", jest.fn().mockRejectedValue(new JournalApiError("not_found", 404)));
        await none.openPathLink();
        expect(none.getSnapshot().controlError).toBe("Nothing numbered #9 is visible to you.");

        const failed = clientAt("/u/alice/9", jest.fn().mockRejectedValue(new Error("offline")));
        await failed.openPathLink();
        expect(failed.getSnapshot().controlError).toBe("Couldn't open #9.");
    });

    it("waits for a session before it uses the link", async () => {
        const lookup = jest.fn().mockResolvedValue({ kind: "item", id: "it_1", num: 5 });
        const client = clientAt("/u/alice/5", lookup);
        const inner = client as unknown as Internals;
        const session = inner.state.session;
        inner.state = { ...inner.state, phase: "signed-out", session: undefined };
        await client.openPathLink();
        expect(lookup).not.toHaveBeenCalled();

        inner.state = { ...inner.state, phase: "signed-in", session };
        jest.spyOn(client, "openNumberHit").mockReturnValue(true);
        await client.openPathLink();
        expect(lookup).toHaveBeenCalledTimes(1);
    });
});

describe("parseOwnTrackerUrl", () => {
    const origin = "https://journal.example";

    it("reads a /u/<name>/<n> link on the given origin, ignoring a query or fragment", () => {
        expect(parseOwnTrackerUrl(`${origin}/u/alice/412`, origin)).toEqual({ user: "alice", num: 412 });
        expect(parseOwnTrackerUrl(`${origin}/u/alice/412?x=1#y`, origin)).toEqual({ user: "alice", num: 412 });
    });

    it("refuses another origin, a relative URL or another path", () => {
        expect(parseOwnTrackerUrl("https://elsewhere.example/u/alice/412", origin)).toBeNull();
        expect(parseOwnTrackerUrl("http://journal.example/u/alice/412", origin)).toBeNull();
        expect(parseOwnTrackerUrl("/u/alice/412", origin)).toBeNull();
        expect(parseOwnTrackerUrl(`${origin}/app/`, origin)).toBeNull();
        expect(parseOwnTrackerUrl("matron://item/7", origin)).toBeNull();
    });
});

describe("MatronJournalClient.openTrackerLink with an https link", () => {
    it("opens the signed-in user's own number in-app", async () => {
        const hit = { kind: "item", id: "it_1", num: 412 };
        const lookup = jest.fn().mockResolvedValue(hit);
        const client = clientAt("/", lookup);
        const open = jest.spyOn(client, "openNumberHit").mockReturnValue(true);

        client.openTrackerLink("link", `${window.location.origin}/u/alice/412`);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(lookup).toHaveBeenCalledWith("alice", 412, undefined);
        expect(open).toHaveBeenCalledWith(hit, 412);
    });

    it("opens another user's link as a web page", () => {
        const lookup = jest.fn();
        const client = clientAt("/", lookup);
        const windowOpen = jest.spyOn(window, "open").mockReturnValue(null);
        const url = `${window.location.origin}/u/bob/412`;

        client.openTrackerLink("link", url);

        expect(lookup).not.toHaveBeenCalled();
        expect(windowOpen).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
        windowOpen.mockRestore();
    });
});
