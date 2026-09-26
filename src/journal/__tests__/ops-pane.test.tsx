/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { decodeServerFrame } from "../frame-decode";
import { effectiveStatus, nextRunText, OpsPane, snapshotTargets } from "../ops/OpsPane";
import { sectionStateFromReply, type OpsSection } from "../ops/model";
import type { ClientState, DeviceDTO } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();

const bridge: DeviceDTO = {
    device_id: 1,
    kind: "agent",
    name: "operator-bridge",
    connected: true,
    is_self: false,
    last_seen_at: NOW,
    status: {
        reported_at: NOW - 60_000,
        limits: {
            as_of: NOW,
            lines: [
                { id: "session", label: "Session", percent: 38 },
                { id: "codex:codex:primary", label: "Codex · 5-hour", percent: 12 },
            ],
        },
        disk: { free_bytes: 40, total_bytes: 100 },
        account: { email: "op@example.com" },
        vitals: { cpu_pct: 23, ram_pct: 61, sampled_at_ms: NOW },
    },
};
const anton: DeviceDTO = { device_id: 15, kind: "agent", name: "anton", connected: true, is_self: false };

type Reply = { ok: true; result: unknown } | { ok: false; code: string };

function fakeClient(reply: (section: OpsSection) => Reply, devices: DeviceDTO[] = [bridge, anton]) {
    return {
        listAgents: jest.fn().mockResolvedValue(devices),
        journalMetrics: jest.fn().mockResolvedValue(null),
        opsSnapshot: jest.fn(async (_id: number, section: OpsSection) =>
            sectionStateFromReply(section, reply(section)),
        ),
        closeOpsView: jest.fn(),
    };
}

async function mount(client: ReturnType<typeof fakeClient>, state: Partial<ClientState> = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(
            <OpsPane
                client={client as unknown as MatronJournalClient}
                state={{ opsView: { open: true }, ...state } as ClientState}
            />,
        );
    });
    // Let the device fetch and the section RPCs settle.
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
    return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
    document.body.innerHTML = "";
});

it("says 'needs bridge update' for an old bridge instead of an error", async () => {
    const client = fakeClient(() => ({ ok: false, code: "unknown_method" }));
    const { container, unmount } = await mount(client);
    const notes = [...container.querySelectorAll(".mj_OpsNote_update")];
    expect(notes).toHaveLength(5);
    expect(notes[0].textContent).toContain("Needs bridge update");
    expect(container.querySelector(".mj_OpsNote_error")).toBeNull();
    // Only the reporting bridge is asked; the anton agent never is.
    expect(new Set(client.opsSnapshot.mock.calls.map((c) => c[0]))).toEqual(new Set([1]));
    await unmount();
});

it("renders the box card with Claude and Codex quotas, and the non-bridge agent as a line", async () => {
    const client = fakeClient(() => ({ ok: false, code: "unknown_method" }));
    const { container, unmount } = await mount(client);
    const card = container.querySelector('[data-spec="ops.box"]')!;
    expect(card.textContent).toContain("operator-bridge");
    expect(card.textContent).toContain("Claude");
    expect(card.textContent).toContain("Codex");
    expect(card.textContent).toContain("op@example.com");
    expect(container.querySelectorAll('[data-spec="ops.box"]')).toHaveLength(1);
    expect(container.querySelector('[data-spec="ops.agent"]')!.textContent).toContain("anton");
    await unmount();
});

it("renders host, alerts and timers when the bridge answers", async () => {
    const data: Record<OpsSection, unknown> = {
        host: {
            cpu_pct: 20,
            memory: { total_bytes: 100, available_bytes: 25 },
            processes: [{ pid: 7, name: "node index.js", rss_bytes: 1024, cpu_pct: 1 }],
        },
        alerts: {
            active: [{ key: "AUDIT_NET_DOWN", severity: "P1", message: "Audit net is not recording" }],
            resolved_24h: [],
        },
        timers: {
            timers: [
                { unit: "anton-watchdog-15m.timer", result: "success", stale: false },
                { unit: "anton-daily.timer", result: "failed", stale: false },
            ],
            cron: [],
        },
        usage: { windows: {}, daily: [] },
        posture: { security: { status: "green", actions: [] }, api_usage: [] },
    };
    const client = fakeClient((section) => ({ ok: true, result: { section, data: data[section] } }));
    const { container, unmount } = await mount(client);
    expect(container.querySelector('[data-spec="ops.processes"]')!.textContent).toContain("node index.js");
    expect(container.querySelector('[data-spec="ops.alert"]')!.textContent).toContain("Audit net is not recording");
    // Problems first: only the failed timer shows until "All" is picked.
    expect(container.querySelectorAll('[data-spec="ops.timer"]')).toHaveLength(1);
    expect(container.querySelector('[data-spec="ops.summary"]')!.textContent).toContain("1 open alert");
    await unmount();
});

it("shows the empty state with no boxes and asks nothing", async () => {
    const client = fakeClient(() => ({ ok: false, code: "unknown_method" }), []);
    const { container, unmount } = await mount(client);
    expect(container.textContent).toContain("No agent boxes");
    expect(client.opsSnapshot).not.toHaveBeenCalled();
    await unmount();
});

it("prefers a newer live box report over the fetched one", () => {
    const newer = { reported_at: NOW + 1000, account: { email: "new@example.com" } };
    expect(effectiveStatus(bridge, { 1: newer })?.account?.email).toBe("new@example.com");
    const older = { reported_at: NOW - 999_999, account: { email: "old@example.com" } };
    expect(effectiveStatus(bridge, { 1: older })?.account?.email).toBe("op@example.com");
    expect(snapshotTargets([bridge, anton]).map((d) => d.device_id)).toEqual([1]);
});

it("words a missed timer run as overdue, not 'next … ago'", () => {
    expect(nextRunText(NOW - 2 * 3_600_000, NOW)).toBe("was due 2h ago");
    expect(nextRunText(NOW + 600_000, NOW)).toBe("next in 10m");
    expect(nextRunText(null, NOW)).toBe("not scheduled");
});

it("decodes the live box_status frame (it used to be dropped as an unknown kind)", () => {
    const result = decodeServerFrame({
        kind: "box_status",
        device_id: 1,
        reported_at: 5,
        disk: { free_bytes: 1, total_bytes: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame).toEqual({
        kind: "box_status",
        device_id: 1,
        status: { reported_at: 5, disk: { free_bytes: 1, total_bytes: 2 } },
    });
    expect(decodeServerFrame({ kind: "box_status" }).ok).toBe(false);
});
