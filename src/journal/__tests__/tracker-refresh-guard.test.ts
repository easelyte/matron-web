/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../client";
import type { ClientState, JournalEvent, Session } from "../types";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 1,
    username: "tester",
};

const missionMarker: JournalEvent = {
    kind: "journal",
    seq: 1,
    convo_id: "c1",
    ts: 1_000,
    sender: "agent:bridge",
    type: "mission",
    payload: { num: 7 },
};

function makeClient(trackerView: ClientState["trackerView"]): {
    client: MatronJournalClient;
    loads: Record<"loadMissions" | "loadProjects" | "loadProject" | "loadMission", jest.Mock>;
} {
    const client = new MatronJournalClient();
    const loads = {
        loadMissions: jest.fn().mockResolvedValue(undefined),
        loadProjects: jest.fn().mockResolvedValue(undefined),
        loadProject: jest.fn().mockResolvedValue(undefined),
        loadMission: jest.fn().mockResolvedValue(undefined),
    };
    Object.assign(client, loads);
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        missions: [],
        projects: [],
        trackerView,
    } as ClientState;
    return { client, loads };
}

// An item marker asks for the detail refetch too (it carries no mission) and, unlike a mission marker,
// does not also load the selected mission straight away, so only the coalesced timer is exercised.
const itemMarker: JournalEvent = { ...missionMarker, type: "item", payload: { num: 99 } };

async function fireMissionMarker(client: MatronJournalClient, marker: JournalEvent = missionMarker): Promise<void> {
    (client as unknown as { handleTrackerMarker(e: JournalEvent): void }).handleTrackerMarker(marker);
    jest.advanceTimersByTime(300);
    await Promise.resolve();
}

describe("mission marker refetch", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("refetches missions and projects while the missions tab is open", async () => {
        const { client, loads } = makeClient({ open: true, view: "missions" });
        await fireMissionMarker(client);
        expect(loads.loadMissions).toHaveBeenCalledTimes(1);
        expect(loads.loadProjects).toHaveBeenCalledTimes(1);
    });

    it("refetches while the inbox tab is open", async () => {
        const { client, loads } = makeClient({ open: true, view: "inbox" });
        await fireMissionMarker(client);
        expect(loads.loadMissions).toHaveBeenCalledTimes(1);
    });

    it("keeps the missions list fresh but skips projects, project and mission pages on the Memories tab", async () => {
        const { client, loads } = makeClient({
            open: true,
            view: "memories",
            selectedProjectId: 3,
            selectedMissionId: 7,
        });
        (client as unknown as { state: ClientState }).state = {
            ...client.getSnapshot(),
            ...(client as unknown as { state: ClientState }).state,
            trackerProject: { project: { num: 3 } },
            trackerMission: { mission: { num: 7 } },
        } as unknown as ClientState;
        await fireMissionMarker(client, itemMarker);
        expect(loads.loadMissions).toHaveBeenCalledTimes(1);
        expect(loads.loadProjects).not.toHaveBeenCalled();
        expect(loads.loadProject).not.toHaveBeenCalled();
        expect(loads.loadMission).not.toHaveBeenCalled();
    });

    it("refetches projects, the selected project and the selected mission on the Missions tab", async () => {
        const { client, loads } = makeClient({
            open: true,
            view: "missions",
            selectedProjectId: 3,
            selectedMissionId: 7,
        });
        (client as unknown as { state: ClientState }).state = {
            ...(client as unknown as { state: ClientState }).state,
            trackerProject: { project: { num: 3 } },
            trackerMission: { mission: { num: 7 } },
        } as unknown as ClientState;
        await fireMissionMarker(client, itemMarker);
        expect(loads.loadProject).toHaveBeenCalledWith(3);
        expect(loads.loadMission).toHaveBeenCalledWith(7);
    });

    it("still refetches while the search tab is open", async () => {
        const { client, loads } = makeClient({ open: true, view: "search" });
        await fireMissionMarker(client);
        expect(loads.loadMissions).toHaveBeenCalledTimes(1);
    });

    it("does not refetch while the tracker is closed", async () => {
        const { client, loads } = makeClient(undefined);
        await fireMissionMarker(client);
        expect(loads.loadMissions).not.toHaveBeenCalled();
    });
});
