/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";

import { JournalApiError } from "../api";
import { MatronJournalClient } from "../client";
import { ItemRow } from "../tracker/ItemRow";
import { ItemsInbox } from "../tracker/ItemsInbox";
import { rowConsentAnswers } from "../tracker/format";
import type { ClientState, TrackerItem } from "../types";
import { trackerItem } from "./tracker-fixtures";

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

const chatAsk = (over: Partial<TrackerItem> = {}): TrackerItem =>
    trackerItem({
        id: "it_7",
        num: 7,
        kind: "question",
        title: "box-a asks to chat with box-b — review",
        labels: ["consent"],
        links: [{ url: "matron://consent/chat/room-1/4", title: "Agent chat request" }],
        actions: ["Approve", "Decline"],
        awaiting: "user",
        ...over,
    });

function clientWith(state: Partial<ClientState>, api: Record<string, jest.Mock>): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = client as unknown as { state: ClientState; api: Record<string, jest.Mock> };
    internals.state = { ...client.getSnapshot(), phase: "signed-in", conversations: [], ...state };
    internals.api = api;
    return client;
}

async function mountInbox(client: MatronJournalClient): Promise<{ container: HTMLElement; unsubscribe: () => void }> {
    const render = (root: Root): void =>
        root.render(
            <ItemsInbox items={client.getSnapshot().inboxItems ?? []} client={client} onOpenItem={jest.fn()} />,
        );
    const { container, root } = await mount(<div />);
    await act(async () => render(root));
    const unsubscribe = client.subscribe(() => render(root));
    return { container, unsubscribe };
}

const answerButton = (container: ParentNode, label: string): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>(".mj_TrackerItemRow_answers button")].find(
        (button) => button.textContent === label,
    )!;

describe("Consent requests answered from their For you row", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        if (typeof globalThis.crypto?.randomUUID !== "function") {
            Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
        }
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("offers a row's answers only on a consent request waiting on the user, with one-tap labels", () => {
        expect(rowConsentAnswers(chatAsk())).toEqual(["Approve", "Decline"]);
        expect(rowConsentAnswers(chatAsk({ actions: ["Accept", "Decline"] }))).toEqual(["Accept", "Decline"]);
        // Settled, handed to an agent, not a consent request, or a button that needs more than a tap.
        expect(rowConsentAnswers(chatAsk({ state: "closed", awaiting: null, resolution: "decided" }))).toEqual([]);
        expect(rowConsentAnswers(chatAsk({ awaiting: "agent" }))).toEqual([]);
        expect(rowConsentAnswers(chatAsk({ labels: [] }))).toEqual([]);
        expect(rowConsentAnswers(chatAsk({ actions: ["Accept", "Pick a box", "Decline"] }))).toEqual([]);
        expect(rowConsentAnswers(chatAsk({ actions: [] }))).toEqual([]);
        expect(rowConsentAnswers(chatAsk({ actions: undefined }))).toEqual([]);
    });

    it("draws Approve filled and Decline outlined under the row, outside the row's own button", async () => {
        const onAnswer = jest.fn();
        const onOpen = jest.fn();
        const { container } = await mount(<ItemRow item={chatAsk()} scope="all" onOpen={onOpen} onAnswer={onAnswer} />);
        const approve = answerButton(container, "Approve");
        const decline = answerButton(container, "Decline");
        expect(approve.classList.contains("mj_TrackerAction_affirmative")).toBe(true);
        expect(decline.classList.contains("mj_TrackerAction_affirmative")).toBe(false);
        expect(approve.closest(".mj_TrackerItemRow")).toBeNull();
        expect(approve.getAttribute("aria-label")).toBe("Approve, number 7");
        await act(async () => decline.click());
        expect(onAnswer).toHaveBeenCalledWith(7, "Decline");
        expect(onOpen).not.toHaveBeenCalled();
    });

    it("draws no answers without onAnswer", async () => {
        const { container } = await mount(<ItemRow item={chatAsk()} onOpen={jest.fn()} />);
        expect(container.querySelector(".mj_TrackerItemRow_answers")).toBeNull();
    });

    it("an Approve tap posts the item action, and the answered request leaves Needs you", async () => {
        const question = trackerItem({ id: "it_1", num: 1, title: "Pick a colour" });
        const answered = chatAsk({ state: "closed", awaiting: null, resolution: "decided" });
        const postItemComment = jest.fn().mockResolvedValue({ item: answered, ok: true });
        const items = jest.fn().mockResolvedValue({ items: [question], next_cursor: null });
        const client = clientWith({ inboxItems: [chatAsk(), question] }, { postItemComment, items });
        const { container, unsubscribe } = await mountInbox(client);

        await act(async () => answerButton(container, "Approve").click());

        expect(postItemComment).toHaveBeenCalledWith(7, { action: "Approve", body: "Approve" }, expect.any(String));
        expect(container.textContent).not.toContain("asks to chat with");
        expect(container.textContent).toContain("Pick a colour");
        unsubscribe();
    });

    it("a tap on a request already answered elsewhere drops the stale row and says so in the journal's words", async () => {
        const refused = new JournalApiError("conflict", 409, "conflict", undefined, {
            error: "conflict",
            reason: "already_answered",
            message: "Already answered: this request was approved.",
        });
        const postItemComment = jest.fn().mockRejectedValue(refused);
        const items = jest.fn().mockResolvedValue({ items: [], next_cursor: null });
        const client = clientWith({ inboxItems: [chatAsk()] }, { postItemComment, items });
        const { container, unsubscribe } = await mountInbox(client);

        await act(async () => answerButton(container, "Approve").click());

        expect(items).toHaveBeenCalled();
        expect(container.textContent).not.toContain("asks to chat with");
        expect(client.getSnapshot().trackerError).toBe("Already answered: this request was approved.");
        unsubscribe();
    });
});
