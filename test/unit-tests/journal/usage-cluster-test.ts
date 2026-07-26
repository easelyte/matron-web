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

    it("renders id-driven short tags and long accessible names (ctx/5h/fbl/wk/cpu/ram)", async () => {
        await renderUsage([
            { id: "context", label: "context", percent: 72, used: 144_000, limit: 200_000 },
            { id: "session_5h", label: "Session", percent: 41 },
            { id: "week_fable", label: "Week (Fable)", percent: 22 },
            { id: "week_all", label: "Week (all models)", percent: 63 },
            { id: "host_cpu", label: "Host CPU", percent: 34 },
            { id: "host_ram", label: "Host RAM", percent: 55 },
        ]);

        const rows = container.querySelectorAll(".mj_UsageRow");
        expect(rows).toHaveLength(6);
        expect([...container.querySelectorAll(".mj_UsageLabel")].map((n) => n.textContent)).toEqual([
            "ctx",
            "5h",
            "fbl",
            "wk",
            "cpu",
            "ram",
        ]);
        expect(
            [...container.querySelectorAll('[role="progressbar"]')].map((n) => n.getAttribute("aria-label")),
        ).toEqual(["context", "5-hour session", "weekly, Fable", "weekly, all models", "host CPU", "host RAM"]);
    });

    it("shows the ctx PERCENT as the visible figure and keeps the raw pair for a11y only", async () => {
        // Operator: the ctx bar's visible number must be its percent (like every other bar),
        // NOT the raw 144k/200k pair. Raw survives only in aria-valuetext + the hover title.
        await renderUsage([{ id: "context", label: "context", percent: 72, used: 144_000, limit: 200_000 }]);

        const row = container.querySelector(".mj_UsageRow")!;
        // No visible raw element / row modifier anymore.
        expect(row.classList.contains("mj_UsageRow_raw")).toBe(false);
        expect(row.querySelector(".mj_UsageRaw")).toBeNull();
        // Visible figure is the percent.
        expect(row.querySelector(".mj_UsagePercent")?.textContent).toBe("72%");
        // Raw pair still reachable: accessible valuetext + hover title.
        expect(row.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("72% used, 144k/200k");
        expect(row.getAttribute("title")).toBe("144k/200k");
    });

    it("omits the raw pair for meters without used/limit", async () => {
        await renderUsage([{ id: "session_5h", label: "Session", percent: 41 }]);
        const row = container.querySelector(".mj_UsageRow")!;
        expect(row.classList.contains("mj_UsageRow_raw")).toBe(false);
        expect(row.querySelector(".mj_UsageRaw")).toBeNull();
        expect(row.querySelector(".mj_UsagePercent")?.textContent).toBe("41%");
        // No used/limit → no raw in valuetext, and no title (no reset here either).
        expect(row.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("41% used");
        expect(row.getAttribute("title")).toBeNull();
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
