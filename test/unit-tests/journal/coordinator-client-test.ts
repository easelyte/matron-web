/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApiError } from "../../../src/journal/api";
import { MatronJournalClient } from "../../../src/journal/client";
import type { ClientState, JournalControlFrame, JournalEvent } from "../../../src/journal/types";

interface ApiMock {
    coordinator: jest.Mock;
    putCoordinator: jest.Mock;
    routines: jest.Mock;
    createRoutine: jest.Mock;
    patchRoutine: jest.Mock;
    deleteRoutine: jest.Mock;
    runRoutine: jest.Mock;
    latestBriefing: jest.Mock;
}

interface Internals {
    state: ClientState;
    api?: ApiMock;
    applyHelloCoordinator(hello: JournalControlFrame): void;
    handleCoordinatorMarker(event: JournalEvent): void;
}

function makeClient(overrides: Partial<ClientState> = {}): { client: MatronJournalClient; internals: Internals } {
    const client = new MatronJournalClient();
    const internals = client as unknown as Internals;
    internals.state = { ...client.getSnapshot(), phase: "signed-in", ...overrides };
    internals.api = {
        coordinator: jest.fn(),
        putCoordinator: jest.fn(),
        routines: jest.fn(),
        createRoutine: jest.fn(),
        patchRoutine: jest.fn(),
        deleteRoutine: jest.fn(),
        runRoutine: jest.fn(),
        latestBriefing: jest.fn(),
    };
    return { client, internals };
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const marker = (type: string, payload: Record<string, unknown> = {}): JournalEvent =>
    ({ seq: 1, convo_id: "c_coord", type, payload, sender: "journal", ts: 1 }) as unknown as JournalEvent;

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "rt_1",
        name: "daily-sweep",
        title: "Daily sweep",
        schedule: "5 7 * * *",
        trigger: null,
        tz: "Europe/London",
        prompt: "Run the daily sweep.",
        enabled: true,
        origin: "seed",
        next_at: 10,
        last_fired_at: null,
        last_outcome: null,
        created_at: 1,
        updated_at: 2,
        ...over,
    };
}

const draft = { title: "Weekly", prompt: "Review the week.", tz: "Europe/London", schedule: "0 9 * * 1" };

describe("Coordinator conversation", () => {
    afterEach(() => jest.useRealTimers());

    it("takes the Coordinator from hello_ok, and asks an older journal that leaves it out", async () => {
        const { client, internals } = makeClient();
        internals.applyHelloCoordinator({ kind: "control", op: "hello_ok", coordinator_convo_id: "c_coord" });
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_coord");
        internals.applyHelloCoordinator({ kind: "control", op: "hello_ok", coordinator_convo_id: null });
        expect(client.getSnapshot().coordinatorConvoId).toBeNull();
        expect(internals.api!.coordinator).not.toHaveBeenCalled();

        internals.api!.coordinator.mockResolvedValue({ convo_id: "c_other", consent: true });
        internals.applyHelloCoordinator({ kind: "control", op: "hello_ok" });
        await flush();
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_other");
    });

    it("refetches once for a burst of coordinator events", async () => {
        jest.useFakeTimers();
        const { client, internals } = makeClient({ coordinatorConvoId: "c_old" });
        internals.api!.coordinator.mockResolvedValue({ convo_id: "c_new", consent: true });
        internals.handleCoordinatorMarker(marker("coordinator", { role: "released" }));
        internals.handleCoordinatorMarker(marker("coordinator", { role: "assigned" }));
        jest.advanceTimersByTime(300);
        await flush();
        expect(internals.api!.coordinator).toHaveBeenCalledTimes(1);
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_new");
    });

    it("keeps a marker's refetch through a briefing load", async () => {
        jest.useFakeTimers();
        const { client, internals } = makeClient({ coordinatorConvoId: "c_old" });
        internals.api!.coordinator.mockResolvedValue({ convo_id: "c_new", consent: true });
        internals.api!.latestBriefing.mockResolvedValue({
            briefing: null,
            refresh: null,
            next_refresh_at: null,
            has_coordinator: true,
        });
        internals.handleCoordinatorMarker(marker("coordinator", { role: "assigned" }));
        await client.loadBriefing();
        jest.advanceTimersByTime(300);
        await flush();
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_new");
    });

    it("drops a GET answer that a newer hello overtook", async () => {
        const { client, internals } = makeClient();
        let resolve!: (value: unknown) => void;
        internals.api!.coordinator.mockReturnValue(new Promise((r) => (resolve = r)));
        const read = client.coordinatorConversationId();
        internals.applyHelloCoordinator({ kind: "control", op: "hello_ok", coordinator_convo_id: "c_hello" });
        resolve({ convo_id: "c_stale" });
        await expect(read).resolves.toBe("c_hello");
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_hello");
    });

    it("asks again when a coordinator event overtakes the read", async () => {
        const { client, internals } = makeClient({ coordinatorConvoId: "c_old" });
        let first!: (value: unknown) => void;
        internals
            .api!.coordinator.mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
            .mockResolvedValueOnce({ convo_id: "c_new", consent: true });
        const read = client.coordinatorConversationId();
        internals.handleCoordinatorMarker(marker("coordinator", { role: "assigned" }));
        first({ convo_id: "c_old", consent: true });
        // The event changed nothing in state yet: the old value is not the answer.
        await expect(read).resolves.toBe("c_new");
        expect(internals.api!.coordinator).toHaveBeenCalledTimes(2);
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_new");
    });

    it("opens the Coordinator conversation, or reports that there is none", async () => {
        const { client, internals } = makeClient();
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        internals.api!.coordinator.mockResolvedValueOnce({ convo_id: "c_coord", consent: true });
        await expect(client.openCoordinator()).resolves.toBe(true);
        expect(select).toHaveBeenCalledWith("c_coord", { suppressNotFound: true });

        internals.api!.coordinator.mockResolvedValueOnce({ convo_id: null, consent: true });
        await expect(client.openCoordinator()).resolves.toBe(false);
        expect(select).toHaveBeenCalledTimes(1);
    });

    it("falls back to the last known Coordinator when the read fails", async () => {
        const { client, internals } = makeClient({ coordinatorConvoId: "c_known" });
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        internals.api!.coordinator.mockRejectedValue(new JournalApiError("offline", 0));
        await expect(client.openCoordinator()).resolves.toBe(true);
        expect(select).toHaveBeenCalledWith("c_known", { suppressNotFound: true });
    });

    it("answers the one Coordinator lookup a shortcut can use as is", async () => {
        const { client, internals } = makeClient({ coordinatorConvoId: "c_known" });
        internals.api!.coordinator.mockResolvedValueOnce({ convo_id: "c_new", consent: false });
        await expect(client.coordinatorConversationId()).resolves.toBe("c_new");
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_new");
        // A failed read answers the last known value; an odd answer or none answers null.
        internals.api!.coordinator.mockRejectedValueOnce(new JournalApiError("offline", 0));
        await expect(client.coordinatorConversationId()).resolves.toBe("c_new");
        internals.api!.coordinator.mockResolvedValueOnce("nope");
        await expect(client.coordinatorConversationId()).resolves.toBeNull();
        internals.api!.coordinator.mockResolvedValueOnce({ convo_id: null });
        await expect(client.coordinatorConversationId()).resolves.toBeNull();
        expect(client.getSnapshot().coordinatorConvoId).toBeNull();
        internals.api!.coordinator.mockRejectedValueOnce(new JournalApiError("offline", 0));
        await expect(client.coordinatorConversationId()).resolves.toBeNull();
        await expect(new MatronJournalClient().coordinatorConversationId()).resolves.toBeNull();
    });

    it("sets and clears the Coordinator through PUT /coordinator, following the journal's answer", async () => {
        const { client, internals } = makeClient({ coordinatorConvoId: null });
        internals.api!.putCoordinator.mockResolvedValueOnce({ convo_id: "c_pick", consent: true });
        await expect(client.setCoordinator("c_pick")).resolves.toBeUndefined();
        expect(internals.api!.putCoordinator).toHaveBeenCalledWith("c_pick");
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_pick");

        internals.api!.putCoordinator.mockResolvedValueOnce({ convo_id: null, consent: true });
        await client.setCoordinator(null);
        expect(internals.api!.putCoordinator).toHaveBeenLastCalledWith(null);
        expect(client.getSnapshot().coordinatorConvoId).toBeNull();
    });

    it("keeps the Coordinator and says why when the journal refuses the pick", async () => {
        const { client, internals } = makeClient({ coordinatorConvoId: "c_coord" });
        internals.api!.putCoordinator.mockRejectedValue(new JournalApiError("Not found", 404, "not_found"));
        await expect(client.setCoordinator("c_gone")).resolves.toMatch(/can't be the Coordinator/);
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_coord");
    });

    it("records the Coordinator from the Settings read too", async () => {
        const { client, internals } = makeClient();
        internals.api!.coordinator.mockResolvedValue({ convo_id: "c_coord", consent: false });
        await client.loadCoordinatorConsent();
        expect(client.getSnapshot().coordinatorConvoId).toBe("c_coord");
        expect(client.getSnapshot().coordinatorConsent?.enabled).toBe(false);
    });
});

describe("Coordinator routines", () => {
    afterEach(() => jest.useRealTimers());

    it("loads when the sheet watches, sorted by name", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [row({ id: "rt_2", name: "unseen" }), row()] });
        const stop = client.watchRoutines();
        await flush();
        expect(client.getSnapshot().routines?.list?.map((routine) => routine.name)).toEqual(["daily-sweep", "unseen"]);
        stop();
    });

    it("marks a journal without routines as unsupported, with no error", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockRejectedValue(new JournalApiError("Not found", 404, "not_found"));
        await client.loadRoutines();
        expect(client.getSnapshot().routines).toMatchObject({ unsupported: true, error: undefined, loading: false });
    });

    it("keeps the list when a refetch fails", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValueOnce({ routines: [row()] });
        await client.loadRoutines();
        internals.api!.routines.mockRejectedValueOnce(new JournalApiError("offline", 0));
        await client.loadRoutines();
        expect(client.getSnapshot().routines).toMatchObject({ error: "offline" });
        expect(client.getSnapshot().routines?.list).toHaveLength(1);
    });

    it("follows routine markers only while the sheet watches", async () => {
        jest.useFakeTimers();
        const { internals, client } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [] });
        internals.handleCoordinatorMarker(marker("routine", { action: "fired" }));
        jest.advanceTimersByTime(300);
        expect(internals.api!.routines).not.toHaveBeenCalled();

        const stop = client.watchRoutines();
        expect(internals.api!.routines).toHaveBeenCalledTimes(1);
        internals.handleCoordinatorMarker(marker("routine", { action: "saved" }));
        internals.handleCoordinatorMarker(marker("routine", { action: "fired" }));
        jest.advanceTimersByTime(300);
        expect(internals.api!.routines).toHaveBeenCalledTimes(2);
        stop();
    });

    it("pauses with PATCH {enabled} and shows the journal's copy at once", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [row()] });
        await client.loadRoutines();
        internals.api!.patchRoutine.mockResolvedValue({ routine: row({ enabled: false, next_at: null }) });
        await expect(client.setRoutineEnabled("rt_1", false)).resolves.toBeUndefined();
        expect(internals.api!.patchRoutine).toHaveBeenCalledWith("rt_1", { enabled: false });
        expect(client.getSnapshot().routines?.list?.[0]).toMatchObject({ enabled: false, next_at: null });
        expect(client.getSnapshot().routines?.busyIds?.size).toBe(0);
    });

    it("says why a pause failed, and reloads when the routine is gone", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [] });
        internals.api!.patchRoutine.mockRejectedValue(new JournalApiError("Not found", 404, "not_found"));
        await expect(client.setRoutineEnabled("rt_1", false)).resolves.toMatch(/no longer exists/);
        expect(internals.api!.routines).toHaveBeenCalled();
    });

    it("runs a routine and words a refusal", async () => {
        const { client, internals } = makeClient();
        internals.api!.runRoutine.mockResolvedValueOnce({ accepted: true });
        await expect(client.runRoutine("rt_1")).resolves.toBeNull();
        internals.api!.runRoutine.mockResolvedValueOnce({ delivered: false, reason: "no_coordinator" });
        await expect(client.runRoutine("rt_1")).resolves.toMatch(/no Coordinator/);
    });

    it("creates with the name and zone, refusing a bad form or a taken name before any request", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [row()] });
        await client.loadRoutines();

        await expect(client.saveRoutine(undefined, "Bad Name", draft)).resolves.toMatch(/lowercase/);
        await expect(client.saveRoutine(undefined, "daily-sweep", draft)).resolves.toMatch(/already exists/);
        expect(internals.api!.createRoutine).not.toHaveBeenCalled();

        internals.api!.createRoutine.mockResolvedValue({
            routine: row({ id: "rt_9", name: "weekly", title: "Weekly", schedule: "0 9 * * 1" }),
        });
        await expect(client.saveRoutine(undefined, "weekly", { ...draft, enabled: false })).resolves.toBeUndefined();
        expect(internals.api!.createRoutine).toHaveBeenCalledWith({
            name: "weekly",
            title: "Weekly",
            prompt: "Review the week.",
            schedule: "0 9 * * 1",
            tz: "Europe/London",
            enabled: false,
        });
        expect(client.getSnapshot().routines?.list?.map((routine) => routine.name)).toEqual(["daily-sweep", "weekly"]);
    });

    it("edits with PATCH and maps a 409 cap to its message", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [row()] });
        await client.loadRoutines();
        internals.api!.patchRoutine.mockResolvedValue({ routine: row({ title: "Morning sweep" }) });
        await client.saveRoutine("rt_1", "daily-sweep", { ...draft, title: "Morning sweep", schedule: "5 7 * * *" });
        expect(internals.api!.patchRoutine).toHaveBeenCalledWith("rt_1", {
            title: "Morning sweep",
            prompt: "Review the week.",
            schedule: "5 7 * * *",
            tz: "Europe/London",
        });
        expect(client.getSnapshot().routines?.list?.[0].title).toBe("Morning sweep");

        internals.api!.createRoutine.mockRejectedValue(
            new JournalApiError("conflict", 409, "conflict", undefined, { blocked_by: "cap" }),
        );
        await expect(client.saveRoutine(undefined, "another", draft)).resolves.toMatch(/50 routines/);
    });

    it("deletes, counting a routine already gone as deleted", async () => {
        const { client, internals } = makeClient();
        internals.api!.routines.mockResolvedValue({ routines: [row(), row({ id: "rt_2", name: "unseen" })] });
        await client.loadRoutines();
        internals.api!.deleteRoutine.mockRejectedValue(new JournalApiError("Not found", 404, "not_found"));
        await expect(client.deleteRoutine("rt_1")).resolves.toBeUndefined();
        expect(client.getSnapshot().routines?.list?.map((routine) => routine.id)).toEqual(["rt_2"]);
    });
});
