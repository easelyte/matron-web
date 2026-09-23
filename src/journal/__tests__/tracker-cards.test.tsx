/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import type { EventPayload, JournalEvent } from "../types";
import { isRenderableItemMarker, ItemCard, ItemInlineNote, renderItemMarker } from "../tracker/cards";

interface FakeClient {
    openTrackerItem: jest.Mock;
}

function fakeClient(): FakeClient {
    return { openTrackerItem: jest.fn() };
}

function event(type: string, payload: EventPayload): JournalEvent {
    return { kind: "journal", seq: 1, convo_id: "c1", ts: 1, sender: "journal", type, payload };
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

describe("renderItemMarker dispatch", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    const client = fakeClient() as unknown as MatronJournalClient;

    it("returns null for the quiet invalidation-only actions and any unknown action", () => {
        expect(renderItemMarker(event("item", { num: 1, action: "reordered" }), client)).toBeNull();
        expect(renderItemMarker(event("item", { num: 1, action: "updated" }), client)).toBeNull();
        expect(renderItemMarker(event("item", { num: 1, action: "who-knows" }), client)).toBeNull();
    });

    it("returns a card for created/closed and an inline note for commented/reopened", () => {
        expect(renderItemMarker(event("item", { num: 1, action: "created" }), client)).not.toBeNull();
        expect(renderItemMarker(event("item", { num: 1, action: "closed" }), client)).not.toBeNull();
        expect(renderItemMarker(event("item", { num: 1, action: "commented" }), client)).not.toBeNull();
        expect(renderItemMarker(event("item", { num: 1, action: "reopened" }), client)).not.toBeNull();
    });

    // F5: rendering and timeline suppression share ONE classifier (isRenderableItemMarker). If they
    // could diverge, an unknown/version-skew action would render null yet survive suppression, leaving
    // a ghost row (empty avatar/bubble). Assert the lock-step: renderItemMarker returns content iff the
    // classifier says renderable, so the suppressor (isSuppressedTrackerEvent = !isRenderableItemMarker)
    // suppresses exactly the null-rendering markers.
    it("keeps isRenderableItemMarker in lock-step with renderItemMarker (no ghost rows)", () => {
        for (const action of ["created", "closed", "commented", "reopened", "reordered", "updated", "who-knows"]) {
            const renders = renderItemMarker(event("item", { num: 1, action }), client) !== null;
            expect(isRenderableItemMarker(event("item", { num: 1, action }))).toBe(renders);
        }
        // The quiet/unknown actions are explicitly non-renderable (→ suppressed, no ghost row).
        expect(isRenderableItemMarker(event("item", { num: 1, action: "reordered" }))).toBe(false);
        expect(isRenderableItemMarker(event("item", { num: 1, action: "updated" }))).toBe(false);
        expect(isRenderableItemMarker(event("item", { num: 1, action: "who-knows" }))).toBe(false);
        // A non-item event is never a renderable item marker.
        expect(isRenderableItemMarker(event("text", { body: "hi" }))).toBe(false);
    });
});

describe("ItemCard", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("renders a created item with the orange needs-you border when awaiting the user", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemCard
                client={client as unknown as MatronJournalClient}
                event={event("item", {
                    num: 3,
                    kind: "question",
                    title: "Pick one",
                    action: "created",
                    awaiting: "user",
                })}
            />,
        );

        const card = container.querySelector(".mj_TrackerCard");
        expect(card?.classList.contains("mj_TrackerCard_needsyou")).toBe(true);
        expect(container.querySelector(".mj_TrackerStatusPill")?.textContent).toBe("Needs you");
        expect(container.querySelector(".mj_TrackerCard_num")?.textContent).toBe("#3");
    });

    it("renders a closed item without the orange border even when it still records awaiting-user", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemCard
                client={client as unknown as MatronJournalClient}
                event={event("item", {
                    num: 3,
                    kind: "decision",
                    title: "Go with Postgres",
                    action: "closed",
                    awaiting: "user",
                    resolution: "decided",
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerCard_needsyou")).toBeNull();
        expect(container.querySelector(".mj_TrackerStatusPill")?.textContent).toBe("Closed · Decided");
    });

    it("falls back to the kind label when the title is absent", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemCard
                client={client as unknown as MatronJournalClient}
                event={event("item", { num: 3, kind: "task", action: "created", awaiting: "agent" })}
            />,
        );

        expect(container.querySelector(".mj_TrackerCard_title")?.textContent).toBe("Task");
    });

    it("opens the item when clicked", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemCard
                client={client as unknown as MatronJournalClient}
                event={event("item", { num: 9, kind: "task", title: "t", action: "created" })}
            />,
        );

        await act(async () => {
            container.querySelector<HTMLButtonElement>(".mj_TrackerCard")!.click();
        });
        expect(client.openTrackerItem).toHaveBeenCalledWith(9);
    });
});

describe("ItemInlineNote", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it("renders a reply lead with the actor and the comment body for a commented marker", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemInlineNote
                client={client as unknown as MatronJournalClient}
                event={event("item", {
                    num: 4,
                    kind: "question",
                    title: "Colour?",
                    action: "commented",
                    by: "user",
                    comment: { body: "let's go yellow" },
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerInlineNote_line")?.textContent).toContain(
            "You replied on #4 · Colour?",
        );
        expect(container.querySelector(".mj_TrackerInlineNote_body")?.textContent).toContain("let's go yellow");
    });

    it("renders a reopened lead with no body and falls back to #num when the title is absent", async () => {
        const client = fakeClient();
        const { container } = await mount(
            <ItemInlineNote
                client={client as unknown as MatronJournalClient}
                event={event("item", {
                    num: 4,
                    kind: "task",
                    action: "reopened",
                    by: "agent",
                    comment: { body: "should be ignored" },
                })}
            />,
        );

        expect(container.querySelector(".mj_TrackerInlineNote_line")?.textContent).toContain("Agent reopened #4 · #4");
        expect(container.querySelector(".mj_TrackerInlineNote_body")).toBeNull();
    });
});
