/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { NavRail } from "../../../src/journal/NavRail";
import {
    goToNumber,
    matchingConversations,
    SearchPage,
    snippetBeyondTitle,
} from "../../../src/journal/tracker/SearchPage";
import type { ClientState, Conversation, GlobalSearchResponse, GlobalSearchResult } from "../../../src/journal/types";

function result(over: Partial<GlobalSearchResult>): GlobalSearchResult {
    return {
        kind: "item",
        id: "it_1",
        num: 12,
        name: null,
        title: "Pick the nginx timeout",
        state: "open",
        mission_num: null,
        why: "exact",
        field: "title",
        snippet: null,
        ...over,
    };
}

const RESPONSE: GlobalSearchResponse = {
    results: [
        result({}),
        result({ kind: "mission", id: "ms_1", num: 20, title: "Proxy hardening", snippet: "**nginx** reload" }),
        result({ kind: "project", id: "pj_1", num: 30, title: "Platform launch", why: "similar" }),
        result({ kind: "memory", id: "proxy-timeouts", num: null, name: "proxy-timeouts", title: "Keep it at 120s" }),
    ],
    chats: [
        {
            convo_id: "c9",
            title: "deploy",
            count: 3,
            exact: true,
            live: false,
            top: { seq: 7, ts: 1, sender: "agent:box-a", excerpt: "restarted **nginx**" },
        },
    ],
};

interface Internals {
    state: ClientState;
    api: unknown;
}

function makeClient(searchAll: jest.Mock, overrides: Partial<ClientState> = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = { ...client.getSnapshot(), phase: "signed-in", ...overrides };
    internals.api = { searchAll };
    return client;
}

function convo(id: string, title: string, snippet = ""): Conversation {
    return { id, title, snippet, last_seq: 1, unread_count: 0, created_at: 1 } as unknown as Conversation;
}

describe("client.searchEverything", () => {
    it("binds the journal's results to their query", async () => {
        const searchAll = jest.fn().mockResolvedValue(RESPONSE);
        const client = makeClient(searchAll);
        await client.searchEverything("  nginx ");
        expect(searchAll).toHaveBeenCalledWith("nginx", expect.any(Number), expect.anything());
        const search = client.getSnapshot().globalSearch!;
        expect(search.query).toBe("nginx");
        expect(search.results.map((r) => r.kind)).toEqual(["item", "mission", "project", "memory"]);
        expect(search.chats).toHaveLength(1);
        expect(search.loading).toBe(false);
    });

    it("drops malformed hits and says when the journal cannot be asked", async () => {
        const client = makeClient(
            jest.fn().mockResolvedValue({ results: [{ kind: "elsewhere", id: "x", title: "x" }, null], chats: "no" }),
        );
        await client.searchEverything("nginx");
        expect(client.getSnapshot().globalSearch).toMatchObject({ results: [], chats: [], failed: false });

        const failing = makeClient(jest.fn().mockRejectedValue(new Error("boom")));
        await failing.searchEverything("nginx");
        expect(failing.getSnapshot().globalSearch).toMatchObject({ query: "nginx", failed: true, loading: false });
    });

    it("ignores an earlier answer that lands after a later query", async () => {
        let resolveFirst!: (value: GlobalSearchResponse) => void;
        const searchAll = jest
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce({ results: [], chats: [] });
        const client = makeClient(searchAll);
        const first = client.searchEverything("ngi");
        await client.searchEverything("nginx");
        resolveFirst(RESPONSE);
        await first;
        expect(client.getSnapshot().globalSearch).toMatchObject({ query: "nginx", results: [] });
    });

    it("keeps an in-flight request when the same text is searched again", async () => {
        let resolve!: (value: GlobalSearchResponse) => void;
        const searchAll = jest.fn().mockImplementationOnce(() => new Promise((r) => (resolve = r)));
        const client = makeClient(searchAll);
        const first = client.searchEverything("nginx");
        await client.searchEverything("nginx ");
        expect(searchAll).toHaveBeenCalledTimes(1);
        expect((searchAll.mock.calls[0][2] as AbortSignal).aborted).toBe(false);
        resolve(RESPONSE);
        await first;
        expect(client.getSnapshot().globalSearch).toMatchObject({ query: "nginx", failed: false, loading: false });
    });

    it("drops hits whose snippet or excerpt is not text", async () => {
        const client = makeClient(
            jest.fn().mockResolvedValue({
                results: [result({}), { ...result({ id: "it_2" }), snippet: 7 }],
                chats: [{ ...RESPONSE.chats![0], top: { seq: 7, ts: 1, sender: "agent:box-a" } }],
            }),
        );
        await client.searchEverything("nginx");
        expect(client.getSnapshot().globalSearch).toMatchObject({ results: [{ id: "it_1" }], chats: [] });
    });

    it("clears the results for an empty query", async () => {
        const client = makeClient(jest.fn().mockResolvedValue(RESPONSE));
        await client.searchEverything("nginx");
        await client.searchEverything("   ");
        expect(client.getSnapshot().globalSearch).toBeUndefined();
    });

    it("openSearch opens the Search page with the given text", () => {
        const client = makeClient(jest.fn());
        client.openSearch("design");
        expect(client.getSnapshot().trackerView).toMatchObject({ open: true, view: "search" });
        expect(client.getSnapshot().globalSearchQuery).toBe("design");
    });

    it("asks an open Search page to take the focus again", () => {
        const client = makeClient(jest.fn());
        client.openSearch();
        const first = client.getSnapshot().globalSearchFocus;
        client.openSearch();
        expect(client.getSnapshot().globalSearchFocus).toBe((first ?? 0) + 1);
    });
});

describe("snippetBeyondTitle", () => {
    it("drops the name and title the journal runs into the snippet", () => {
        expect(
            snippetBeyondTitle("**Postgres** 16 **Postgres** 16 migration Move the app to **Postgres** 16.", [
                "Postgres 16",
                "Postgres 16 migration",
            ]),
        ).toBe("Move the app to **Postgres** 16.");
        expect(
            snippetBeyondTitle("Pick the **Postgres** window Saturday or Sunday?", [null, "Pick the Postgres window"]),
        ).toBe("Saturday or Sunday?");
    });

    it("keeps a snippet that does not start with the title, and drops one that is only the title", () => {
        expect(snippetBeyondTitle("…restarted **nginx** on box-a", [null, "Proxy"])).toBe(
            "…restarted **nginx** on box-a",
        );
        expect(snippetBeyondTitle("**Proxy** hardening", [null, "Proxy hardening"])).toBeNull();
    });
});

describe("goToNumber (Enter on the Search field)", () => {
    it("opens what a bare number names and leaves any other query alone", async () => {
        const client = makeClient(jest.fn());
        const lookup = jest
            .spyOn(client, "lookupNumber")
            .mockResolvedValue({ status: "found", hit: { kind: "item", id: "it_1", num: 12 } });
        const open = jest.spyOn(client, "openNumberHit").mockReturnValue(true);
        expect(await goToNumber(client, "#12")).toBe(true);
        expect(open).toHaveBeenCalledWith({ kind: "item", id: "it_1", num: 12 }, 12);
        expect(await goToNumber(client, "nginx")).toBe(false);
        expect(lookup).toHaveBeenCalledTimes(1);
        lookup.mockResolvedValueOnce({ status: "none" });
        expect(await goToNumber(client, "99")).toBe(false);
    });
});

describe("matchingConversations", () => {
    it("matches every word across the title and latest message", () => {
        const list = [convo("a", "matron-web deploy", "restarted nginx"), convo("b", "backup rotation")];
        expect(matchingConversations(list, "deploy nginx").map((c) => c.id)).toEqual(["a"]);
        expect(matchingConversations(list, "ROTATION").map((c) => c.id)).toEqual(["b"]);
        expect(matchingConversations(list, " ")).toEqual([]);
    });
});

describe("SearchPage", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered!.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    async function render(client: MatronJournalClient): Promise<HTMLDivElement> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(SearchPage, { client, state: client.getSnapshot() }));
        });
        rendered = { container, root };
        return container;
    }

    function headings(container: HTMLElement): string[] {
        return [...container.querySelectorAll(".mj_SearchPage_section h2")].map((h) => h.textContent ?? "");
    }

    const loaded = (): Partial<ClientState> => ({
        globalSearchQuery: "nginx",
        globalSearch: {
            query: "nginx",
            results: RESPONSE.results,
            chats: RESPONSE.chats!,
            loading: false,
            failed: false,
        },
        conversations: [convo("c1", "nginx rollout")],
    });

    it("groups the hits by kind and opens what is tapped", async () => {
        const client = makeClient(jest.fn().mockResolvedValue(RESPONSE), loaded());
        const openItem = jest.spyOn(client, "openTrackerItem").mockImplementation(() => undefined);
        const openMemory = jest.spyOn(client, "openTrackerMemory").mockImplementation(() => undefined);
        const container = await render(client);
        expect(headings(container)).toEqual(["Conversations", "Items", "Missions", "Projects", "Memories", "Messages"]);
        expect(container.textContent).toContain("similar meaning");

        const rows = [...container.querySelectorAll<HTMLButtonElement>(".mj_SearchPage_row")];
        await act(async () => rows.find((r) => r.textContent?.includes("#12 Pick the nginx timeout"))!.click());
        expect(openItem).toHaveBeenCalledWith(12);
        await act(async () => rows.find((r) => r.textContent?.includes("proxy-timeouts"))!.click());
        expect(openMemory).toHaveBeenCalledWith("proxy-timeouts");
    });

    it("narrows to one kind with the chips", async () => {
        const client = makeClient(jest.fn().mockResolvedValue(RESPONSE), loaded());
        const container = await render(client);
        const chip = [...container.querySelectorAll<HTMLButtonElement>(".mj_SearchPage_chip")].find(
            (c) => c.textContent === "Memories",
        )!;
        await act(async () => chip.click());
        expect(headings(container)).toEqual(["Memories"]);
    });

    it("says when nothing matches", async () => {
        const client = makeClient(jest.fn(), {
            globalSearchQuery: "zzz",
            globalSearch: { query: "zzz", results: [], chats: [], loading: false, failed: false },
        });
        const container = await render(client);
        expect(container.textContent).toContain("No results");
    });
});

describe("NavRail Search entry", () => {
    it("sits at the foot of the rail and selects the search key", async () => {
        const onSelect = jest.fn();
        const container = document.createElement("div");
        const root = createRoot(container);
        await act(async () => {
            root.render(React.createElement(NavRail, { active: "search", counts: {}, onSelect }));
        });
        const entries = container.querySelectorAll<HTMLButtonElement>(".mj_NavRail_entry");
        const first = entries[entries.length - 1];
        expect(first.dataset.nav).toBe("search");
        expect(first.getAttribute("aria-current")).toBe("page");
        await act(async () => first.click());
        expect(onSelect).toHaveBeenCalledWith("search");
        await act(async () => root.unmount());
    });
});
