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
import errorFixture from "./fixtures/work-view-error.json";
import okFixture from "./fixtures/work-view-ok.json";

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

function WorkHarness({ api }: { api: WorkViewLoader }): React.ReactElement {
    const { state } = useWorkView(api, "repo");
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
        expect(ok.status === "ok" ? ok.groups[0].loops[0].claim?.holder_label : "wrong").toBeNull();
        expect(empty).toEqual({ schema_version: 1, status: "empty", group_by: "repo", groups: [] });
        expect(error.status).toBe("error");
        expect(error.status === "error" ? error.error.code : "wrong").toBe("builder_timeout");
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

    it("GETs the Bearer-authenticated Work endpoint with grouping and cancellation", async () => {
        fetchMock.mockResolvedValue(jsonResponse(okFixture));
        const api = new JournalApi("https://journal.example", "device-token");
        const controller = new AbortController();

        await expect(api.work("domain", controller.signal)).resolves.toMatchObject({ status: "ok" });
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/work?group_by=domain");
        expect(fetchMock.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                method: "GET",
                signal: controller.signal,
                headers: expect.objectContaining({ Authorization: "Bearer device-token" }),
            }),
        );
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

        expect(container.textContent).toContain("Add the Work pane");
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
        expect(container.textContent).not.toContain("Add the Work pane");
        await unmount(root);
    });

    it("surfaces an error envelope with its code instead of rendering empty", async () => {
        const work = jest.fn().mockResolvedValue(parseWorkViewEnvelope(errorFixture));
        const { container, root } = await mount(<WorkHarness api={{ work }} />);

        expect(container.textContent).toContain("builder_timeout");
        expect(container.textContent).not.toContain("No active work");
        await unmount(root);
    });
});
