/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { TrackerPane } from "../../../src/journal/tracker/TrackerPane";
import type { ClientState, Mission, MissionDetail } from "../../../src/journal/types";

function mission(over: Partial<Mission> = {}): Mission {
    return {
        id: "ms_1",
        num: 5,
        state: "open",
        title: "Ship the tracker",
        body: "",
        close_summary: null,
        closed_by: null,
        closed_over_open_items: 0,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: 1,
        updated_at: 1,
        last_milestone_at: null,
        closed_at: null,
        open_items: 0,
        needs_you: 0,
        conversations: 0,
        milestones: 0,
        last_milestone: null,
        ...over,
    };
}

function missionDetail(over: Partial<Mission> = {}): MissionDetail {
    return { mission: mission(over), milestones: [], items: [], conversations: [] };
}

interface Internals {
    state: ClientState;
}

function makeClient(overrides: Partial<ClientState>): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = { ...client.getSnapshot(), phase: "signed-in", ...overrides };
    return client;
}

async function renderPane(client: MatronJournalClient): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(TrackerPane, { client, state: client.getSnapshot() }));
    });
    return { container, root };
}

function textButton(container: HTMLElement, text: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    if (!match) throw new Error(`Missing button: ${text}`);
    return match;
}

describe("TrackerPane mission load failures", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("offers a retry when the selected mission failed to load with nothing to show, and re-tapping reloads it", async () => {
        const client = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            missions: [mission({ num: 5 })],
            trackerMission: null,
            missionLoadError: { id: "5", message: "gone away" },
        });
        const load = jest.spyOn(client, "loadMission").mockResolvedValue(undefined);
        rendered = await renderPane(client);

        // Not the missions list: the failed selection owns the pane body.
        expect(rendered.container.querySelector(".mj_TrackerMiniItem, .mj_TrackerMissionRow")).toBeNull();
        const retry = textButton(rendered.container, "Try again");
        await act(async () => {
            retry.click();
        });
        expect(load).toHaveBeenCalledWith(5);
    });

    it("ignores a load error recorded for a different mission", async () => {
        const client = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 6 },
            missions: [mission({ num: 6 })],
            trackerMission: null,
            missionLoadError: { id: "5", message: "gone away" },
        });
        jest.spyOn(client, "loadMission").mockResolvedValue(undefined);
        rendered = await renderPane(client);
        expect(
            [...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Try again"),
        ).toBe(false);
    });

    it("keeps a loaded mission on screen after a failed refresh, with a stale notice and retry", async () => {
        const client = makeClient({
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            missions: [mission({ num: 5 })],
            trackerMission: missionDetail({ num: 5 }),
            missionLoadError: { id: "5", message: "gone away" },
        });
        const load = jest.spyOn(client, "loadMission").mockResolvedValue(undefined);
        rendered = await renderPane(client);

        expect(rendered.container.textContent).toContain("Ship the tracker");
        const notice = rendered.container.querySelector(".mj_TrackerStaleNotice");
        expect(notice).not.toBeNull();
        await act(async () => {
            textButton(notice as HTMLElement, "Try again").click();
        });
        expect(load).toHaveBeenCalledWith(5);
    });
});
