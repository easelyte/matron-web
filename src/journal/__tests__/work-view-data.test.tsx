/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApi, JournalApiError } from "../api";
import { MatronJournalClient } from "../client";
import {
    useWorkView,
    WORK_VIEW_REFRESH_INTERVAL_MS,
    type WorkViewLoader,
    type WorkViewLoadState,
} from "../use-work-view";
import { parseWorkViewEnvelope, type WorkViewEnvelope } from "../work-view";
import emptyFixture from "./fixtures/work-view-empty.json";
import okDomainFixture from "./fixtures/work-view-ok-domain.json";
import errorFixture from "./fixtures/work-view-error.json";
import okFixture from "./fixtures/work-view-ok.json";
import okDetailFixture from "./fixtures/work-view-ok-detail.json";

const fetchMock = jest.fn();
const typeGenerator = require("../../contracts/generate-work-view-types.cjs") as {
    generateTypes(schema: Buffer): string;
    OUTPUT_PATH: string;
    SCHEMA_PATH: string;
};

function jsonResponse(body: unknown): Pick<Response, "status" | "headers" | "arrayBuffer"> {
    const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
    return {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        arrayBuffer: async () => encoded.buffer,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function renderState(state: WorkViewLoadState): string {
    switch (state.status) {
        case "loading":
            return "Loading Work";
        case "request_error":
            return state.error.message;
        case "error":
            return `${state.error.code}: ${state.error.message}`;
        case "empty":
            return "No active work";
        case "ok":
            return state.groups.flatMap((group) => group.loops.map((loop) => loop.title)).join(", ");
    }
}

function WorkHarness({
    api,
    refreshIntervalMs,
    requestTimeoutMs,
}: {
    api: WorkViewLoader;
    refreshIntervalMs?: number;
    requestTimeoutMs?: number;
}): React.ReactElement {
    const { state } = useWorkView(api, "repo", refreshIntervalMs, requestTimeoutMs);
    return <div>{renderState(state)}</div>;
}

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(element);
    });
    return { container, root };
}

async function unmount(root: Root): Promise<void> {
    await act(async () => root.unmount());
}

// These checked-in payloads are captured from the producer's build_work_payload output. Keeping
// the raw JSON shape (rather than normalising it in a consumer helper) preserves the real boundary.
describe("Work-view wire contract", () => {
    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("regenerates the checked-in TypeScript contract with no diff", () => {
        const regenerated = typeGenerator.generateTypes(readFileSync(typeGenerator.SCHEMA_PATH));
        expect(readFileSync(typeGenerator.OUTPUT_PATH, "utf8")).toBe(regenerated);
    });

    it("parses producer ok, empty, and error envelopes as distinct variants", () => {
        const ok = parseWorkViewEnvelope(okFixture);
        const empty = parseWorkViewEnvelope(emptyFixture);
        const error = parseWorkViewEnvelope(errorFixture);

        expect(ok.status).toBe("ok");
        // Loop 901 carries a label; 902 is the default two-argument claim_loop
        // call, which the producer serialises with holder_label: null. Both
        // variants are asserted because the null one drives the pane's
        // convo_id-derived fallback copy.
        expect(ok.status === "ok" ? ok.groups[0].loops[0].claim?.holder_label : "wrong").toBe("matron-web wave");
        expect(ok.status === "ok" ? ok.groups[0].loops[1].claim?.holder_label : "wrong").toBeNull();
        expect(empty).toEqual({ schema_version: 1, status: "empty", group_by: "repo", groups: [] });
        expect(error.status).toBe("error");
        expect(error.status === "error" ? error.error.code : "wrong").toBe("store_missing");
    });

    it("rejects schema drift instead of passing an untyped response downstream", () => {
        expect(() => parseWorkViewEnvelope({ ...errorFixture, status: "empty" })).toThrow(/unexpected fields/);
        expect(() =>
            parseWorkViewEnvelope({
                ...errorFixture,
                error: { ...errorFixture.error, code: "unexpected_failure" },
            }),
        ).toThrow(/error code is invalid/);
        expect(() =>
            parseWorkViewEnvelope({
                ...okFixture,
                groups: [
                    {
                        ...okFixture.groups[0],
                        loops: [
                            {
                                ...okFixture.groups[0].loops[0],
                                claim: { ...okFixture.groups[0].loops[0].claim, claimed_at: "not-a-date" },
                            },
                        ],
                    },
                ],
            }),
        ).toThrow(/claimed_at is invalid/);
    });

    it("accepts the optional loop detail fields from a detail-capable producer", () => {
        const detailed = parseWorkViewEnvelope(okDetailFixture);
        if (detailed.status !== "ok") throw new Error("expected ok");
        const first = detailed.groups[0].loops[0];
        expect(first.opened).toBe("2026-09-01T09:00:00Z");
        expect(first.next_action).toBe("Build the detail view, then run the contact sheet.");
        expect(first.owner).toBe("operator");

        // An older journal omits them entirely, and the parse keeps them absent rather than
        // inventing empty values the UI would then have to second-guess.
        const legacy = parseWorkViewEnvelope(okFixture);
        if (legacy.status !== "ok") throw new Error("expected ok");
        expect(Object.keys(legacy.groups[0].loops[0]).sort()).toEqual(
            ["claim", "description", "domain", "id", "priority", "repo", "status", "title"].sort(),
        );
    });

    it("validates the optional loop fields as strictly as the required ones when present", () => {
        const withLoop = (patch: Record<string, unknown>): unknown => ({
            ...okDetailFixture,
            groups: [{ ...okDetailFixture.groups[0], loops: [{ ...okDetailFixture.groups[0].loops[0], ...patch }] }],
        });
        expect(() => parseWorkViewEnvelope(withLoop({ opened: "last week" }))).toThrow(/loop opened is invalid/);
        expect(() => parseWorkViewEnvelope(withLoop({ owner: "" }))).toThrow(/loop owner is invalid/);
        expect(() => parseWorkViewEnvelope(withLoop({ next_action: 7 }))).toThrow(/loop next_action is invalid/);
        expect(() => parseWorkViewEnvelope(withLoop({ tags: ["x"] }))).toThrow(/unexpected fields/);
        const missingRequired = { ...okDetailFixture.groups[0].loops[0] } as Record<string, unknown>;
        delete missingRequired.description;
        expect(() =>
            parseWorkViewEnvelope({ ...okDetailFixture, groups: [{ key: "matron-web", loops: [missingRequired] }] }),
        ).toThrow(/unexpected fields/);
    });

    it("GETs the Bearer-authenticated Work endpoint with grouping and cancellation", async () => {
        // The fixture is real producer output grouped by repo, so ask for repo:
        // requesting "domain" here would (correctly) be rejected as a grouping
        // mismatch by the guard exercised in the next test.
        fetchMock.mockResolvedValue(jsonResponse(okFixture));
        const api = new JournalApi("https://journal.example", "device-token");
        const controller = new AbortController();

        await expect(api.work("repo", controller.signal)).resolves.toMatchObject({ status: "ok" });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/work?group_by=repo");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "GET",
                signal: controller.signal,
                headers: expect.objectContaining({ Authorization: "Bearer device-token" }),
            }),
        );
    });

    it("parses the producer's domain-grouped envelope, not just the repo one", async () => {
        // Both groupings are real producer output over the same store, so this
        // asserts the second axis is actually exercised rather than shipped
        // unparsed. Domain grouping is a different partition of the same loops,
        // so the loop count matches while the group keys differ.
        const repo = parseWorkViewEnvelope(okFixture);
        const domain = parseWorkViewEnvelope(okDomainFixture);

        expect(domain.status).toBe("ok");
        expect(domain.group_by).toBe("domain");
        const keys = domain.status === "ok" ? domain.groups.map((group) => group.key) : [];
        expect(keys).toContain("unassigned");
        expect(keys).not.toEqual(repo.status === "ok" ? repo.groups.map((group) => group.key) : []);

        const count = (envelope: WorkViewEnvelope) =>
            envelope.status === "ok" ? envelope.groups.reduce((n, group) => n + group.loops.length, 0) : -1;
        expect(count(domain)).toBe(count(repo));
    });

    it("requests the domain grouping and accepts the matching producer response", async () => {
        fetchMock.mockResolvedValue(jsonResponse(okDomainFixture));
        const api = new JournalApi("https://journal.example", "device-token");

        await expect(api.work("domain")).resolves.toMatchObject({ status: "ok", group_by: "domain" });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/work?group_by=domain");
    });

    it("rejects a structurally valid envelope grouped by something other than what was requested", async () => {
        // A producer bug, a stale cache or version skew can return a valid
        // repo-grouped envelope for a domain request. The pane's tab is driven by
        // local state, so accepting it would render repo groups under the Domain
        // tab with no warning -- a silently wrong operational view, worse than an
        // error. Asserted for `ok` and for `empty`; an `error` envelope is already
        // a failure signal and carries group_by only incidentally.
        const api = new JournalApi("https://journal.example", "device-token");

        fetchMock.mockResolvedValue(jsonResponse(okFixture));
        await expect(api.work("domain")).rejects.toThrow(/grouped by "repo" but "domain" was requested/);

        fetchMock.mockResolvedValue(jsonResponse(emptyFixture));
        await expect(api.work("domain")).rejects.toThrow(/grouped by "repo" but "domain" was requested/);

        // The matching grouping still resolves, so the guard is not blanket-rejecting.
        fetchMock.mockResolvedValue(jsonResponse(okFixture));
        await expect(api.work("repo")).resolves.toMatchObject({ status: "ok", group_by: "repo" });
    });

    it("turns a malformed successful Work response into a typed API error", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ status: "empty", groups: [] }));
        const api = new JournalApi("https://journal.example", "device-token");

        const request = api.work();
        await expect(request).rejects.toBeInstanceOf(JournalApiError);
        await expect(request).rejects.toMatchObject({ status: 200 });
    });

    it("exposes Work through the component-facing client with the same grouping and signal", async () => {
        const envelope = parseWorkViewEnvelope(emptyFixture);
        const work = jest.fn().mockResolvedValue(envelope);
        const client = new MatronJournalClient();
        (client as unknown as { api: { work: typeof work } }).api = { work };
        const controller = new AbortController();

        await expect(client.work("domain", controller.signal)).resolves.toBe(envelope);
        expect(work).toHaveBeenCalledWith("domain", controller.signal);
    });
});

describe("mounted Work-view refresh", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        document.body.replaceChildren();
    });

    it("refetches on the bounded interval and re-renders a changed producer response", async () => {
        const changedFixture = structuredClone(okFixture);
        changedFixture.groups[0].loops[0].title = "Render refreshed work";
        const work = jest
            .fn()
            .mockResolvedValueOnce(parseWorkViewEnvelope(okFixture))
            .mockResolvedValueOnce(parseWorkViewEnvelope(changedFixture));
        const { container, root } = await mount(<WorkHarness api={{ work }} />);

        expect(container.textContent).toContain("work-view-fixture-claimed-with-label");
        await act(async () => jest.advanceTimersByTime(WORK_VIEW_REFRESH_INTERVAL_MS));

        expect(work).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain("Render refreshed work");
        await unmount(root);
    });

    it("refetches when the mounted window regains focus", async () => {
        const work = jest.fn().mockResolvedValue(parseWorkViewEnvelope(emptyFixture));
        const { root } = await mount(<WorkHarness api={{ work }} />);

        act(() => window.dispatchEvent(new Event("focus")));
        expect(work).toHaveBeenCalledTimes(2);
        await unmount(root);
    });

    it("aborts request #1 and never lets its late response replace newer request #2", async () => {
        const stale = deferred<WorkViewEnvelope>();
        const fresh = deferred<WorkViewEnvelope>();
        const work = jest.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
        const { container, root } = await mount(<WorkHarness api={{ work }} />);
        const firstSignal = work.mock.calls[0][1] as AbortSignal;

        act(() => window.dispatchEvent(new Event("focus")));
        expect(firstSignal.aborted).toBe(true);

        const freshFixture = structuredClone(okFixture);
        freshFixture.groups[0].loops[0].title = "Newest work";
        await act(async () => fresh.resolve(parseWorkViewEnvelope(freshFixture)));
        expect(container.textContent).toContain("Newest work");

        await act(async () => stale.resolve(parseWorkViewEnvelope(okFixture)));
        expect(container.textContent).toContain("Newest work");
        expect(container.textContent).not.toContain("work-view-fixture-claimed-with-label");
        await unmount(root);
    });

    it("bounds a request the transport never settles, instead of loading forever", async () => {
        // Electron's journalRequest IPC bridge observes no AbortSignal, so an
        // aborted request can still be in flight there. Without a deadline that
        // settles regardless of transport, the pane sits on "Loading Work..."
        // indefinitely.
        const work = jest.fn().mockReturnValue(new Promise<never>(() => {}));
        const { container, root } = await mount(
            <WorkHarness api={{ work }} refreshIntervalMs={20_000} requestTimeoutMs={15_000} />,
        );
        expect(container.textContent).toContain("Loading");

        await act(async () => {
            jest.advanceTimersByTime(15_000);
        });
        expect(container.textContent).toContain("timed out");
        await unmount(root);
    });

    it("does not resume unattended ticks after the UI deadline while the transport is still pending", async () => {
        // The sharp case: the deadline fires at 15s and the pane correctly shows
        // a timeout, but on Electron the underlying IPC is uncancellable and
        // still live. If occupancy were released by the DEADLINE rather than by
        // the call settling, the 20s tick would start another uncancellable
        // request -- one more every interval, forever. Advances well past BOTH
        // the deadline and several intervals.
        const work = jest.fn().mockReturnValue(new Promise<never>(() => {}));
        const { container, root } = await mount(
            <WorkHarness api={{ work }} refreshIntervalMs={20_000} requestTimeoutMs={15_000} />,
        );
        expect(work).toHaveBeenCalledTimes(1);

        await act(async () => {
            jest.advanceTimersByTime(15_000);
        });
        expect(container.textContent).toContain("timed out");

        await act(async () => {
            jest.advanceTimersByTime(80_000);
        });
        expect(work).toHaveBeenCalledTimes(1);
        await unmount(root);
    });

    it("resumes unattended ticks once the transport actually settles", async () => {
        // The other half of the same contract: occupancy must not latch forever.
        const settled = deferred<WorkViewEnvelope>();
        const work = jest.fn().mockReturnValueOnce(settled.promise).mockResolvedValue(parseWorkViewEnvelope(okFixture));
        const { root } = await mount(
            <WorkHarness api={{ work }} refreshIntervalMs={20_000} requestTimeoutMs={15_000} />,
        );
        expect(work).toHaveBeenCalledTimes(1);

        await act(async () => settled.resolve(parseWorkViewEnvelope(okFixture)));
        await act(async () => {
            jest.advanceTimersByTime(20_000);
        });
        expect(work).toHaveBeenCalledTimes(2);
        await unmount(root);
    });

    it("does not let unattended interval ticks stack live requests on a wedged transport", async () => {
        // The failure this guards: one live request accumulating per interval for
        // as long as the transport hangs, none of which the renderer can cancel.
        const work = jest.fn().mockReturnValue(new Promise<never>(() => {}));
        const { root } = await mount(
            // Interval deliberately SHORTER than the request deadline so several
            // ticks land while the first request is still outstanding -- the
            // production values cannot overlap, and this proves the backpressure
            // rather than relying on that ordering.
            <WorkHarness api={{ work }} refreshIntervalMs={1_000} requestTimeoutMs={60_000} />,
        );
        expect(work).toHaveBeenCalledTimes(1);

        await act(async () => {
            jest.advanceTimersByTime(5_000);
        });
        expect(work).toHaveBeenCalledTimes(1);
        await unmount(root);
    });

    it("still lets a focus refresh supersede an in-flight request", async () => {
        // Backpressure applies to unattended ticks only. Focus is the user asking
        // for current data; dropping it would leave the pane stale with no
        // feedback. Superseding is safe because of the abort + generation guard.
        const work = jest.fn().mockReturnValue(new Promise<never>(() => {}));
        const { root } = await mount(
            <WorkHarness api={{ work }} refreshIntervalMs={1_000} requestTimeoutMs={60_000} />,
        );
        expect(work).toHaveBeenCalledTimes(1);

        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(work).toHaveBeenCalledTimes(2);
        await unmount(root);
    });

    it("surfaces an error envelope with its code instead of rendering empty", async () => {
        const work = jest.fn().mockResolvedValue(parseWorkViewEnvelope(errorFixture));
        const { container, root } = await mount(<WorkHarness api={{ work }} />);

        expect(container.textContent).toContain("store_missing");
        expect(container.textContent).not.toContain("No active work");
        await unmount(root);
    });
});
