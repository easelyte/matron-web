/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { buildUsageMeters, UsageCluster } from "../../../src/journal/components";
import { mergeSessionStatus, worstLimit } from "../../../src/journal/status";
import { type SessionStatus } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type Limits = NonNullable<SessionStatus["limits"]>;

let container: HTMLDivElement;
let root: Root;

async function renderUsage(limits: Limits, now?: number): Promise<void> {
    await act(async () => root.render(React.createElement(UsageCluster, { limits, now })));
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

    it("renders a host vital with a FRESH sampled_at_ms normally (no stale state)", async () => {
        const now = 1_000_000_000_000;
        await renderUsage([{ id: "host_cpu", label: "Host CPU", percent: 34, sampled_at_ms: now - 10_000 }], now);

        const row = container.querySelector(".mj_UsageRow")!;
        expect(row.classList.contains("mj_UsageRow_stale")).toBe(false);
        // Accessible name is the plain long label; no "last sampled" suffix, no title.
        expect(row.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("host CPU");
        expect(row.getAttribute("title")).toBeNull();
        expect(row.querySelector(".mj_UsagePercent")?.textContent).toBe("34%");
    });

    it("dims a host vital with a STALE sampled_at_ms and surfaces the age in aria + title", async () => {
        const now = 1_000_000_000_000;
        // 4 minutes old → past HOST_VITALS_STALE_MS (60s).
        await renderUsage([{ id: "host_cpu", label: "Host CPU", percent: 34, sampled_at_ms: now - 240_000 }], now);

        const row = container.querySelector(".mj_UsageRow")!;
        expect(row.classList.contains("mj_UsageRow_stale")).toBe(true);
        expect(row.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
            "host CPU, last sampled 4m ago",
        );
        expect(row.getAttribute("title")).toBe("host CPU, last sampled 4m ago");
        // Still shows the value (no layout shift / hard removal), just dimmed via the class.
        expect(row.querySelector(".mj_UsagePercent")?.textContent).toBe("34%");
    });

    it("never applies stale logic to meters WITHOUT sampled_at_ms (ctx/5h/wk/fbl unaffected)", async () => {
        const now = 1_000_000_000_000;
        await renderUsage(
            [
                { id: "session_5h", label: "Session", percent: 41 },
                { id: "week_all", label: "Week (all models)", percent: 63 },
            ],
            now,
        );

        for (const row of container.querySelectorAll(".mj_UsageRow")) {
            expect(row.classList.contains("mj_UsageRow_stale")).toBe(false);
        }
        expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("5-hour session");
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

describe("buildUsageMeters host vitals (status.vitals source + #529 live override)", () => {
    const vitals = { cpu_pct: 10, ram_pct: 20, sampled_at_ms: 1_000 };
    const accountLimits: Limits = [{ id: "session_5h", label: "Session", percent: 41 }];

    function byId(meters: Limits, id: string): Limits[number] {
        const found = meters.find((meter) => meter.id === id);
        if (!found) throw new Error(`meter ${id} not present`);
        return found;
    }

    it("synthesizes host_cpu / host_ram from the TOP-LEVEL status.vitals (upstream #156 contract)", () => {
        const meters = buildUsageMeters({ vitals }, accountLimits);

        expect(byId(meters, "host_cpu")).toMatchObject({
            id: "host_cpu",
            label: "host CPU",
            percent: 10,
            sampled_at_ms: 1_000,
        });
        expect(byId(meters, "host_ram")).toMatchObject({
            id: "host_ram",
            label: "host RAM",
            percent: 20,
            sampled_at_ms: 1_000,
        });
        expect(byId(meters, "session_5h").percent).toBe(41);
    });

    it("renders EXACTLY ONE cpu and one ram meter when a bridge also injects them into limits[]", () => {
        // The reverted bridge behaviour (and any client that meets an un-updated bridge
        // mid-deploy) puts synthetic host_cpu/host_ram entries in limits[]. Those must not
        // double-render alongside the vitals-derived pair. Here vitals carries the newer
        // stamp (1000 vs 5), so freshness resolves to it.
        const meters = buildUsageMeters({ vitals }, [
            { id: "host_cpu", label: "Host CPU", percent: 99, sampled_at_ms: 5 },
            { id: "host_ram", label: "Host RAM", percent: 85, sampled_at_ms: 5 },
            ...accountLimits,
        ]);

        expect(meters.filter((meter) => meter.id === "host_cpu")).toHaveLength(1);
        expect(meters.filter((meter) => meter.id === "host_ram")).toHaveLength(1);
        // The surviving pair is the vitals one, not the injected limits one.
        expect(byId(meters, "host_cpu").percent).toBe(10);
        expect(byId(meters, "host_ram").percent).toBe(20);
        // The real account quota is not displaced.
        expect(byId(meters, "session_5h").percent).toBe(41);
    });

    it("lets a NEWER limits[] host entry win over a retained stale vitals (bridge rollback)", () => {
        // Composed path, which neither half's tests covered on their own. mergeSessionStatus
        // otherwise carries `vitals` across an update that omits it, so after a rollback to a
        // bridge that sends host meters in limits[] again, a stale reading would sit there
        // forever masking every newer legacy sample and pinning the header to a frozen number.
        const afterRollback = mergeSessionStatus(
            { vitals: { cpu_pct: 10, ram_pct: 20, sampled_at_ms: 1_000 } },
            { limits: [{ id: "host_cpu", label: "Host CPU", percent: 66, sampled_at_ms: 9_000 }] },
        );

        expect(afterRollback.vitals).toBeUndefined();

        const meters = buildUsageMeters(afterRollback, afterRollback.limits);

        expect(meters.filter((meter) => meter.id === "host_cpu")).toHaveLength(1);
        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 66, sampled_at_ms: 9_000 });
    });

    it("hands the meters back to UNSTAMPED legacy entries after a rollback (vitals evicted)", () => {
        // The pre-#156 wire shape had no sampled_at_ms on host meters at all, so freshness has
        // nothing to rank them on. mergeSessionStatus therefore evicts the retained vitals when
        // an update asserts the legacy contract, rather than leaving a stale stamped reading to
        // outrank every unstamped sample that follows it.
        const afterRollback = mergeSessionStatus(
            { vitals: { cpu_pct: 10, ram_pct: 20, sampled_at_ms: 1_000 } },
            { limits: [{ id: "host_cpu", label: "Host CPU", percent: 66 }] },
        );

        expect(afterRollback.vitals).toBeUndefined();

        const meters = buildUsageMeters(afterRollback, afterRollback.limits);

        expect(meters.filter((meter) => meter.id === "host_cpu")).toHaveLength(1);
        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 66 });
        // The evicted vitals takes its ram half with it — the legacy producer is now the source.
        expect(meters.some((meter) => meter.id === "host_ram")).toBe(false);
    });

    it("does NOT evict vitals when the bridge sends both (forward deploy window)", () => {
        const merged = mergeSessionStatus(undefined, {
            vitals: { cpu_pct: 10, ram_pct: 20, sampled_at_ms: 1_000 },
            limits: [{ id: "host_cpu", label: "Host CPU", percent: 99, sampled_at_ms: 5 }],
        });

        expect(merged.vitals).toEqual({ cpu_pct: 10, ram_pct: 20, sampled_at_ms: 1_000 });
        expect(byId(buildUsageMeters(merged, merged.limits), "host_cpu").percent).toBe(10);
    });

    it("lets a warmed CPU push fill a half that status.vitals reported as null", () => {
        // The bridge sends cpu_pct: null until its sampler has two ticks, and status only
        // republishes at turn end — so a conversation opened during warm-up must still pick up
        // the CPU bar from the ~5s push rather than waiting for the next turn to end.
        const meters = buildUsageMeters({ vitals: { cpu_pct: null, ram_pct: 20, sampled_at_ms: 1_000 } }, undefined, {
            cpu: 44,
            ram: 21,
            sampled_at_ms: 2_000,
        });

        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 44, sampled_at_ms: 2_000 });
    });

    it("still ranks normally when the CLIENT clock runs minutes behind the bridge", () => {
        // Both stamps are ahead of local time here. A skew-relative plausibility bound would
        // reject both and freeze the meter on the turn-end reading; an absolute one lets the
        // newer push win, because the comparison between candidates is purely relative.
        const ahead = Date.now() + 6 * 60_000;
        const meters = buildUsageMeters({ vitals: { cpu_pct: 10, ram_pct: 20, sampled_at_ms: ahead } }, undefined, {
            cpu: 44,
            ram: 21,
            sampled_at_ms: ahead + 5_000,
        });

        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 44, sampled_at_ms: ahead + 5_000 });
    });

    it("ignores an implausibly-future stamp for ranking instead of pinning the meter", () => {
        const meters = buildUsageMeters({ vitals: { cpu_pct: 10, ram_pct: 20, sampled_at_ms: 1e308 } }, [
            { id: "host_cpu", label: "Host CPU", percent: 66, sampled_at_ms: Date.now() },
        ]);

        // The bogus stamp cannot outrank a real sample, so the legacy reading wins.
        expect(byId(meters, "host_cpu").percent).toBe(66);
    });

    it("prefers a legacy limits[] entry that is stamped when vitals carries no stamp at all", () => {
        // An unstamped candidate has no freshness to compare, so it must not outrank a real
        // sample just by being the "newer" contract.
        const meters = buildUsageMeters(
            { vitals: { cpu_pct: 10, ram_pct: 20, sampled_at_ms: undefined as unknown as number } },
            [{ id: "host_cpu", label: "Host CPU", percent: 66, sampled_at_ms: 9_000 }],
        );

        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 66, sampled_at_ms: 9_000 });
    });

    it("keeps limits[] host entries when the bridge sends no vitals (pre-#156 fallback)", () => {
        const meters = buildUsageMeters(undefined, [
            { id: "host_cpu", label: "Host CPU", percent: 10, sampled_at_ms: 1_000 },
            { id: "host_ram", label: "Host RAM", percent: 20, sampled_at_ms: 1_000 },
            ...accountLimits,
        ]);

        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 10, sampled_at_ms: 1_000 });
        expect(byId(meters, "host_ram")).toMatchObject({ percent: 20, sampled_at_ms: 1_000 });
    });

    it("skips a null / non-finite vitals half individually", () => {
        // The bridge emits cpu_pct: null until its CPU sampler has two ticks after boot.
        const warming = buildUsageMeters({ vitals: { cpu_pct: null, ram_pct: 20, sampled_at_ms: 1_000 } }, undefined);
        expect(warming.some((meter) => meter.id === "host_cpu")).toBe(false);
        expect(byId(warming, "host_ram").percent).toBe(20);

        const broken = buildUsageMeters(
            { vitals: { cpu_pct: Number.NaN, ram_pct: Number.POSITIVE_INFINITY, sampled_at_ms: 1_000 } },
            undefined,
        );
        expect(broken.some((meter) => meter.id === "host_cpu" || meter.id === "host_ram")).toBe(false);
    });

    it("renders no host meters at all when status.vitals is absent (graceful degradation)", () => {
        const meters = buildUsageMeters({ context: { tokens: 100, window: 1_000, pct: 10 } }, accountLimits);
        expect(meters.some((meter) => meter.id === "host_cpu" || meter.id === "host_ram")).toBe(false);
    });

    it("overrides the synthesized host percent + sampled_at_ms from the global push (#529)", () => {
        const meters = buildUsageMeters({ vitals }, accountLimits, {
            cpu: 77,
            ram: 88,
            sampled_at_ms: 9_999,
        });

        expect(byId(meters, "host_cpu")).toMatchObject({ percent: 77, sampled_at_ms: 9_999 });
        expect(byId(meters, "host_ram")).toMatchObject({ percent: 88, sampled_at_ms: 9_999 });
        // Non-host meters are untouched by the override.
        expect(byId(meters, "session_5h").percent).toBe(41);
    });

    it("falls back to the status.vitals figures when the global push is absent", () => {
        for (const absent of [undefined, null]) {
            const meters = buildUsageMeters({ vitals }, accountLimits, absent);
            expect(byId(meters, "host_cpu")).toMatchObject({ percent: 10, sampled_at_ms: 1_000 });
            expect(byId(meters, "host_ram")).toMatchObject({ percent: 20, sampled_at_ms: 1_000 });
        }
    });

    it("does not synthesize host meters from the global push alone (vitals is the source)", () => {
        const meters = buildUsageMeters(undefined, accountLimits, {
            cpu: 77,
            ram: 88,
            sampled_at_ms: 9_999,
        });
        expect(meters.some((meter) => meter.id === "host_cpu" || meter.id === "host_ram")).toBe(false);
    });

    it("an overridden FRESH sampled_at_ms renders the host bar un-dimmed (staleness safety net)", async () => {
        const now = 1_000_000_000_000;
        // The status.vitals stamp is ancient (would be stale), but the global push is fresh → override wins.
        const meters = buildUsageMeters({ vitals: { cpu_pct: 12, ram_pct: 20, sampled_at_ms: now - 240_000 } }, [], {
            cpu: 55,
            ram: 60,
            sampled_at_ms: now - 3_000,
        });

        await renderUsage(
            meters.filter((meter) => meter.id === "host_cpu"),
            now,
        );
        const row = container.querySelector(".mj_UsageRow")!;
        expect(row.classList.contains("mj_UsageRow_stale")).toBe(false);
        expect(row.querySelector(".mj_UsagePercent")?.textContent).toBe("55%");
    });

    it("a stale status.vitals stamp with no push still dims the bar", async () => {
        const now = 1_000_000_000_000;
        const meters = buildUsageMeters(
            { vitals: { cpu_pct: 12, ram_pct: 20, sampled_at_ms: now - 240_000 } },
            undefined,
        );

        await renderUsage(
            meters.filter((meter) => meter.id === "host_cpu"),
            now,
        );
        const row = container.querySelector(".mj_UsageRow")!;
        expect(row.classList.contains("mj_UsageRow_stale")).toBe(true);
    });
});
