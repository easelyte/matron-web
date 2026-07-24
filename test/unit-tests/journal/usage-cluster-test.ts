/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { UsageCluster } from "../../../src/journal/components";
import { worstLimit } from "../../../src/journal/status";
import { type SessionStatus } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type Limits = NonNullable<SessionStatus["limits"]>;

let container: HTMLDivElement;
let root: Root;

async function renderUsage(limits: Limits): Promise<void> {
    await act(async () => root.render(React.createElement(UsageCluster, { limits })));
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
});

describe("UsageCluster", () => {
    it("renders all non-blank limits with visible percentages and progressbar ARIA", async () => {
        const limits = Array.from({ length: 12 }, (_, index) => ({
            label: `Limit ${index + 1}`,
            percent: index + 0.4,
            resets: "soon",
        }));
        limits.splice(4, 0, { label: "   ", percent: 99, resets: "soon" });

        await renderUsage(limits);

        const rows = container.querySelectorAll(".mj_UsageRow");
        expect(rows).toHaveLength(12);
        expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(12);
        expect(rows[0].querySelector(".mj_UsagePercent")?.textContent).toBe("0%");
        expect(rows[0].querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0.4");
        expect(rows[0].querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe(
            "0.4% used, resets soon",
        );
        expect(container.textContent).not.toContain("99%");
    });

    it("renders non-finite usage as unknown and excludes it from worst-limit selection", async () => {
        const limits = [
            { label: "5h", percent: NaN },
            { label: "Week", percent: 10 },
        ];

        await renderUsage(limits);

        const unknownRow = container.querySelectorAll(".mj_UsageRow")[0];
        const progressbar = unknownRow.querySelector('[role="progressbar"]');
        expect(unknownRow.querySelector(".mj_UsageFill_unknown")).not.toBeNull();
        expect(unknownRow.querySelector(".mj_UsagePercent")?.textContent).toBe("—");
        expect(progressbar?.getAttribute("aria-valuetext")).toBe("usage unknown");
        expect(progressbar?.hasAttribute("aria-valuenow")).toBe(false);
        expect(worstLimit(limits)).toBe(limits[1]);
    });

    it("uses duplicate-safe row keys", async () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

        await renderUsage([
            { label: "Session", percent: 20 },
            { label: "Session", percent: 80 },
        ]);

        expect(container.querySelectorAll(".mj_UsageRow")).toHaveLength(2);
        expect(consoleError.mock.calls.some(([message]) => String(message).includes("same key"))).toBe(false);
    });
});
