/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { JournalApiError } from "../../../src/journal/api";
import {
    archiveStore,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    unreadStore,
} from "../../../src/journal/client";
import { EventContent, MatronApp } from "../../../src/journal/components";
import { eventSnippet } from "../../../src/journal/types";
import type { ClientState, Conversation, JournalEvent, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const CONVERSATION: Conversation = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "dan",
};

interface ClientInternals {
    state: ClientState;
    database?: unknown;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(options: { events?: JournalEvent[] } = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: options.events ?? [],
        pendingMessages: [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

async function renderClient(client: MatronJournalClient): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(MatronApp, { client }));
    });
    return { container, root };
}

const spawnCardEvent = (over: Record<string, unknown> = {}): JournalEvent => ({
    seq: 40,
    convo_id: "c1",
    ts: 1700000000,
    sender: "agent:dev-6",
    type: "permission_request",
    payload: {
        kind: "agent_spawn",
        request_id: "spawn-1",
        from_device_id: 7,
        from_name: "dev-6",
        from_convo_id: "c1",
        from_convo_title: "Fix the flaky tests",
        target_device_id: 12,
        target_name: "eric",
        workdir: "/home/dan/proj",
        task: "Run the suite and fix flakes",
        topic: "Flake hunt",
        ...over,
    },
});

const spawnOutcomeEvent = (outcome: string, extra: Record<string, unknown> = {}, seq = 41): JournalEvent => ({
    seq,
    convo_id: "c1",
    ts: 1700000100,
    sender: "journal",
    type: "spawn_outcome",
    payload: { request_id: "spawn-1", outcome, ...extra },
});

// For manually controlling exactly when a mocked client.answerAgentSpawn call settles, so a
// test can start a second attempt while the first is still in flight (the #23 race).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("agent_spawn card dispatch", () => {
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

    it("renders the spawn card with headline, detail rows, task, and actions", async () => {
        rendered = await renderClient(signedInClient({ events: [spawnCardEvent()] }));

        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card).not.toBeNull();
        expect(card?.querySelector(".mj_PromptCard_permission")).toBeNull();
        expect(card?.querySelector(".mj_SpawnHeadline")?.textContent).toBe("Flake hunt");
        expect(card?.querySelector(".mj_SpawnDetail_target .mj_SpawnDetail_value")?.textContent).toBe("eric");
        expect(card?.querySelector(".mj_SpawnDetail_folder .mj_SpawnDetail_value")?.textContent).toBe("/home/dan/proj");
        expect(card?.querySelector(".mj_SpawnDetail_from .mj_SpawnDetail_value")?.textContent).toContain(
            "Fix the flaky tests",
        );
        expect(card?.querySelector(".mj_SpawnDetail_from .mj_SpawnDetail_value")?.textContent).toContain("dev-6");
        expect(card?.querySelector(".mj_SpawnTask")?.textContent).toBe("Run the suite and fix flakes");
        expect([...(card?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
            "Deny",
            "Approve",
        ]);
    });

    it("falls back to the first line of the task when topic is absent", async () => {
        rendered = await renderClient(
            signedInClient({ events: [spawnCardEvent({ topic: undefined, task: "Line one\nLine two" })] }),
        );

        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card?.querySelector(".mj_SpawnHeadline")?.textContent).toBe("Line one");
        expect(card?.querySelector(".mj_SpawnTask")?.textContent).toBe("Line one\nLine two");
    });

    // An unanswerable spawn payload must never render live buttons: the generic permission
    // card's Allow/Deny would post through sendPromptReply, a channel the bridge doesn't listen
    // on for spawns. It renders as a read-only spawn card instead.
    it("renders a read-only spawn card (no buttons) when request_id is missing", async () => {
        rendered = await renderClient(signedInClient({ events: [spawnCardEvent({ request_id: undefined })] }));

        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card).not.toBeNull();
        expect(card!.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_PromptCard_permission")).toBeNull();
    });

    it("renders a read-only spawn card (no buttons) when task is empty", async () => {
        rendered = await renderClient(signedInClient({ events: [spawnCardEvent({ task: "" })] }));

        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card).not.toBeNull();
        expect(card!.querySelector(".mj_PromptOptions")).toBeNull();
        expect(rendered.container.querySelector(".mj_PromptCard_permission")).toBeNull();
    });
});

describe("agent_spawn card resolved states", () => {
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

    it("shows Started and an Open button, with no action buttons, once a started outcome arrives", async () => {
        rendered = await renderClient(
            signedInClient({
                events: [spawnCardEvent(), spawnOutcomeEvent("started", { room_id: "r1", child_convo_id: "cc1" })],
            }),
        );

        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Started");
        expect(card?.querySelector(".mj_SpawnOpenButton")).not.toBeNull();
        expect(
            [...(card?.querySelectorAll(".mj_PromptOptions button") ?? [])].map((button) => button.textContent),
        ).toEqual([]);
    });

    it("shows Denied for a declined outcome", async () => {
        rendered = await renderClient(signedInClient({ events: [spawnCardEvent(), spawnOutcomeEvent("declined")] }));
        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Denied");
        expect(card?.querySelector(".mj_SpawnOpenButton")).toBeNull();
    });

    it("shows Expired for an expired outcome", async () => {
        rendered = await renderClient(signedInClient({ events: [spawnCardEvent(), spawnOutcomeEvent("expired")] }));
        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Expired");
    });

    it("shows Failed with the error code for a failed outcome", async () => {
        rendered = await renderClient(
            signedInClient({ events: [spawnCardEvent(), spawnOutcomeEvent("failed", { error_code: "boom" })] }),
        );
        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Failed — boom");
    });

    it("never crashes on an unknown outcome value and shows neutral copy", async () => {
        rendered = await renderClient(
            signedInClient({ events: [spawnCardEvent(), spawnOutcomeEvent("something-new")] }),
        );
        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Spawn request resolved");
    });
});

describe("spawn_outcome standalone row", () => {
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

    it.each([
        ["started", {}, "🚀 Spawned session started"],
        ["declined", {}, "🚫 Spawn declined"],
        ["expired", {}, "⌛ Spawn request expired"],
        ["failed", { error_code: "boom" }, "❌ Spawn failed — boom"],
        ["something-new", {}, "Spawn request resolved"],
    ])("renders the %s status line without a card present", async (outcome, extra, expected) => {
        rendered = await renderClient(
            signedInClient({ events: [spawnOutcomeEvent(outcome, extra as Record<string, unknown>)] }),
        );
        const row = rendered.container.querySelector(".mj_SpawnOutcomeRow");
        expect(row).not.toBeNull();
        expect(row?.textContent).toBe(expected);
    });

    it("shows an Open button only for the started outcome", async () => {
        rendered = await renderClient(
            signedInClient({ events: [spawnOutcomeEvent("started", { room_id: "r1", child_convo_id: "cc1" })] }),
        );
        expect(rendered.container.querySelector(".mj_SpawnOutcomeRow .mj_SpawnOpenButton")).not.toBeNull();

        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        rendered = await renderClient(signedInClient({ events: [spawnOutcomeEvent("declined")] }));
        expect(rendered.container.querySelector(".mj_SpawnOutcomeRow .mj_SpawnOpenButton")).toBeNull();
    });

    it("does not render a raw JSON dump for spawn_outcome events", async () => {
        rendered = await renderClient(signedInClient({ events: [spawnOutcomeEvent("started", { room_id: "r1" })] }));
        expect(rendered.container.querySelector(".mj_Unknown")).toBeNull();
    });
});

describe("eventSnippet for spawn_outcome", () => {
    // Byte-exact with the server's own snapshot snippet strings — bare, no error-code suffix,
    // and terse for an unrecognised outcome. Deliberately DIFFERENT from the timeline row's
    // richer copy (spawnOutcomeSnippet, covered in "spawn_outcome standalone row" above), which
    // keeps the error-code suffix and the "Spawn request resolved" neutral copy.
    it.each([
        ["started", {}, "🚀 Spawned session started"],
        ["declined", {}, "🚫 Spawn declined"],
        ["expired", {}, "⌛ Spawn request expired"],
        ["failed", { error_code: "boom" }, "❌ Spawn failed"],
        ["something-new", {}, "[spawn_outcome]"],
    ])("maps outcome %s to its sidebar snippet", (outcome, extra, expected) => {
        expect(eventSnippet("spawn_outcome", { request_id: "spawn-1", outcome, ...extra })).toBe(expected);
    });
});

describe("agent_spawn answer flow", () => {
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
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    async function renderEventContent(
        client: MatronJournalClient,
        event: JournalEvent,
        spawnOutcomes: ReadonlyMap<string, Record<string, unknown>> = new Map(),
        isReadOnly = false,
    ): Promise<{ container: HTMLDivElement; root: Root }> {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                    spawnOutcomes,
                    isReadOnly,
                }),
            );
        });
        return { container, root };
    }

    function findButton(container: Element, label: string): HTMLButtonElement | undefined {
        return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === label,
        );
    }

    it.each([
        ["Approve", "approve"],
        ["Deny", "deny"],
    ])(
        "tapping %s POSTs the decision via client.answerAgentSpawn and shows Sending… without resolving",
        async (label, decision) => {
            const client = signedInClient();
            const answerAgentSpawn = jest.spyOn(client, "answerAgentSpawn").mockReturnValue(new Promise(() => {}));
            rendered = await renderEventContent(client, spawnCardEvent());
            const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

            await act(async () => findButton(card, label)?.click());

            expect(answerAgentSpawn).toHaveBeenCalledTimes(1);
            expect(answerAgentSpawn).toHaveBeenCalledWith("spawn-1", decision, expect.any(AbortSignal));
            expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
            expect(card.querySelector(".mj_Answered")).toBeNull();
            expect(
                [...card.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")].every((b) => b.disabled),
            ).toBe(true);
        },
    );

    it("resolves a pending tap ONLY when the durable spawn_outcome event arrives, not on the POST response", async () => {
        const client = signedInClient();
        jest.spyOn(client, "answerAgentSpawn").mockResolvedValue(undefined);
        const request = spawnCardEvent();
        rendered = await renderEventContent(client, request);
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect(card.querySelector(".mj_Answered")).toBeNull();

        await act(async () => {
            rendered!.root.render(
                React.createElement(EventContent, {
                    client,
                    event: request,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                    spawnOutcomes: new Map([["spawn-1", { request_id: "spawn-1", outcome: "started", room_id: "r1" }]]),
                }),
            );
        });

        expect(card.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card.querySelector(".mj_Answered")?.textContent).toBe("Started");
        expect(card.querySelector(".mj_SpawnOpenButton")).not.toBeNull();
    });

    it("becomes retryable if no durable outcome arrives within the confirmation window", async () => {
        jest.useFakeTimers();
        const client = signedInClient();
        const answerAgentSpawn = jest.spyOn(client, "answerAgentSpawn").mockResolvedValue(undefined);
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        await act(async () => jest.advanceTimersByTime(10_000));

        expect(card.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card.querySelector(".mj_PromptResolved_retryable")?.textContent).toBe(
            "Reply not confirmed — tap to retry",
        );
        const buttons = [...card.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")];
        expect(buttons.every((b) => !b.disabled)).toBe(true);

        await act(async () => findButton(card, "Approve")?.click());
        expect(answerAgentSpawn).toHaveBeenCalledTimes(2);
    });

    it("aborts the stalled POST when the confirmation window expires, before re-enabling the buttons", async () => {
        jest.useFakeTimers();
        const client = signedInClient();
        // Never settles — models a POST stalled in flight.
        const answerAgentSpawn = jest.spyOn(client, "answerAgentSpawn").mockReturnValue(new Promise(() => {}));
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());
        const firstSignal = answerAgentSpawn.mock.calls[0][2] as AbortSignal;
        expect(firstSignal.aborted).toBe(false);

        await act(async () => jest.advanceTimersByTime(10_000));

        // The stalled Approve must be dead by the time Deny is tappable again — otherwise the
        // user's corrective Deny races their own abandoned tap server-side.
        expect(firstSignal.aborted).toBe(true);
        expect(card.querySelector(".mj_PromptResolved_retryable")).not.toBeNull();

        await act(async () => findButton(card, "Deny")?.click());
        const secondSignal = answerAgentSpawn.mock.calls[1][2] as AbortSignal;
        expect(secondSignal.aborted).toBe(false);
    });

    it("shows the resolved-expired copy immediately on a 409 (already answered elsewhere or expired)", async () => {
        const client = signedInClient();
        jest.spyOn(client, "answerAgentSpawn").mockRejectedValue(new JournalApiError("conflict", 409));
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());

        expect(card.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card.querySelector(".mj_Answered")?.textContent).toBe("Already answered or expired");
        expect(card.querySelectorAll(".mj_PromptOptions button")).toHaveLength(0);
    });

    it("shows the gone copy immediately on a 404 (request row no longer exists)", async () => {
        const client = signedInClient();
        jest.spyOn(client, "answerAgentSpawn").mockRejectedValue(new JournalApiError("gone", 404));
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Deny")?.click());

        expect(card.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card.querySelector(".mj_Answered")?.textContent).toBe("That request is no longer on the server.");
        expect(card.querySelectorAll(".mj_PromptOptions button")).toHaveLength(0);
    });

    it("goes back to answerable with retry copy on a transport error, and a retry resends", async () => {
        const client = signedInClient();
        const answerAgentSpawn = jest
            .spyOn(client, "answerAgentSpawn")
            .mockRejectedValueOnce(new JournalApiError("Could not reach the journal server.", 0))
            .mockResolvedValueOnce(undefined);
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());

        expect(card.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card.querySelector(".mj_PromptResolved_retryable")?.textContent).toBe(
            "Reply not confirmed — tap to retry",
        );
        const buttons = [...card.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")];
        expect(buttons.every((b) => !b.disabled)).toBe(true);

        await act(async () => findButton(card, "Approve")?.click());
        expect(answerAgentSpawn).toHaveBeenCalledTimes(2);
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
    });

    it("a late-settling attempt A transport-error rejection never clobbers attempt B's in-flight sending state", async () => {
        jest.useFakeTimers();
        const client = signedInClient();
        const attemptA = deferred<void>();
        const attemptB = deferred<void>();
        const answerAgentSpawn = jest
            .spyOn(client, "answerAgentSpawn")
            .mockReturnValueOnce(attemptA.promise)
            .mockReturnValueOnce(attemptB.promise);
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        // Attempt A: tap Approve — its POST stays in flight for the rest of the test.
        await act(async () => findButton(card, "Approve")?.click());
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        // A's own confirmation window elapses with no durable event -> retryable, re-enabling the buttons.
        await act(async () => jest.advanceTimersByTime(10_000));
        expect(card.querySelector(".mj_PromptResolved_retryable")?.textContent).toBe(
            "Reply not confirmed — tap to retry",
        );

        // Attempt B: tap Approve again — a fresh POST fires while A's original one is STILL pending.
        await act(async () => findButton(card, "Approve")?.click());
        expect(answerAgentSpawn).toHaveBeenCalledTimes(2);
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        // A finally settles, late, with a transport error — must not touch B's state at all.
        await act(async () => attemptA.reject(new JournalApiError("Could not reach the journal server.", 0)));

        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect(card.querySelector(".mj_PromptResolved_retryable")).toBeNull();
        expect(card.querySelector(".mj_Answered")).toBeNull();
        const buttons = [...card.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")];
        expect(buttons.every((b) => b.disabled)).toBe(true);
    });

    it("a late-settling attempt A 409 never clobbers attempt B's in-flight sending state, resolved or rejected", async () => {
        jest.useFakeTimers();
        const client = signedInClient();
        const attemptA = deferred<void>();
        const attemptB = deferred<void>();
        jest.spyOn(client, "answerAgentSpawn")
            .mockReturnValueOnce(attemptA.promise)
            .mockReturnValueOnce(attemptB.promise);
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());
        await act(async () => jest.advanceTimersByTime(10_000));
        expect(card.querySelector(".mj_PromptResolved_retryable")?.textContent).toBe(
            "Reply not confirmed — tap to retry",
        );

        await act(async () => findButton(card, "Approve")?.click());
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        // A finally settles, late, with a 409 (already answered elsewhere/expired) — must not
        // flip B's card to the resolved-expired copy.
        await act(async () => attemptA.reject(new JournalApiError("conflict", 409)));

        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect(card.querySelector(".mj_Answered")).toBeNull();
        const buttons = [...card.querySelectorAll<HTMLButtonElement>(".mj_PromptOptions button")];
        expect(buttons.every((b) => b.disabled)).toBe(true);

        // B itself still resolves normally once its own POST settles.
        await act(async () => attemptB.resolve(undefined));
        expect(card.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
    });

    it("never sends always_allow — the answer call carries only request_id and decision", async () => {
        const client = signedInClient();
        const answerAgentSpawn = jest.spyOn(client, "answerAgentSpawn").mockResolvedValue(undefined);
        rendered = await renderEventContent(client, spawnCardEvent());
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        await act(async () => findButton(card, "Approve")?.click());

        expect(answerAgentSpawn.mock.calls[0].slice(0, 2)).toEqual(["spawn-1", "approve"]);
        expect(answerAgentSpawn.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    });

    it("hides Deny/Approve entirely when the card renders read-only (sub-chat transcript)", async () => {
        const client = signedInClient();
        rendered = await renderEventContent(client, spawnCardEvent(), new Map(), true);
        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;

        expect(card.querySelectorAll(".mj_PromptOptions button")).toHaveLength(0);
    });

    it("resets its local pending state when reused for a different event identity", async () => {
        const client = signedInClient();
        const answerAgentSpawn = jest.spyOn(client, "answerAgentSpawn").mockReturnValue(new Promise(() => {}));
        const firstRequest = spawnCardEvent();
        rendered = await renderEventContent(client, firstRequest);

        await act(async () => findButton(rendered!.container, "Approve")?.click());
        expect(rendered.container.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        const nextRequest: JournalEvent = {
            ...firstRequest,
            seq: 43,
            payload: { ...firstRequest.payload, request_id: "spawn-2", task: "A different task entirely" },
        };
        await act(async () => {
            rendered!.root.render(
                React.createElement(EventContent, {
                    client,
                    event: nextRequest,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                    spawnOutcomes: new Map(),
                }),
            );
        });

        const card = rendered.container.querySelector(".mj_PromptCard_spawn")!;
        expect(card.textContent).toContain("A different task entirely");
        expect(card.querySelector(".mj_PromptResolved")).toBeNull();
        expect([...card.querySelectorAll(".mj_PromptOptions button")].map((b) => b.textContent)).toEqual([
            "Deny",
            "Approve",
        ]);
        expect(answerAgentSpawn).toHaveBeenCalledTimes(1);
    });

    it("does not let a spawn_outcome missing request_id resolve an unrelated card (memo hygiene)", async () => {
        const card = spawnCardEvent({ request_id: "undefined" });
        const malformedOutcome: JournalEvent = {
            seq: 41,
            convo_id: "c1",
            ts: 1700000100,
            sender: "journal",
            type: "spawn_outcome",
            payload: { outcome: "started", room_id: "rX" }, // request_id entirely absent
        };
        rendered = await renderClient(signedInClient({ events: [card, malformedOutcome] }));

        const cardEl = rendered.container.querySelector(".mj_PromptCard_spawn");
        expect(cardEl?.querySelector(".mj_Answered")).toBeNull();
        expect([...(cardEl?.querySelectorAll(".mj_PromptOptions button") ?? [])].map((b) => b.textContent)).toEqual([
            "Deny",
            "Approve",
        ]);
    });
});

describe("agent_spawn Open / deep-link", () => {
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
        jest.restoreAllMocks();
    });

    // suppressNotFound, NOT fromRpcCreate: Open is tapped long after creation, and fromRpcCreate
    // would arm the sync watchdog — which only an incoming frame clears — so opening an idle
    // spawned session would surface a false "not syncing" error.
    it("Open on a resolved card navigates via selectConversation with suppressNotFound only", async () => {
        const client = signedInClient({
            events: [spawnCardEvent(), spawnOutcomeEvent("started", { room_id: "r1", child_convo_id: "cc1" })],
        });
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard_spawn");
        const openButton = card?.querySelector<HTMLButtonElement>(".mj_SpawnOpenButton");

        await act(async () => openButton?.click());

        expect(selectConversation).toHaveBeenCalledWith("r1", { suppressNotFound: true });
    });

    it("Open on the standalone outcome row navigates via selectConversation with suppressNotFound only", async () => {
        const client = signedInClient({ events: [spawnOutcomeEvent("started", { room_id: "r1" })] });
        const selectConversation = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const openButton = rendered.container.querySelector<HTMLButtonElement>(
            ".mj_SpawnOutcomeRow .mj_SpawnOpenButton",
        );

        await act(async () => openButton?.click());

        expect(selectConversation).toHaveBeenCalledWith("r1", { suppressNotFound: true });
    });
});
