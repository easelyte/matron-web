/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { ItemDetail } from "../tracker/ItemDetail";
import { hidingReplacedComments } from "../tracker/replaced-comments";
import { fakeSeen, trackerComment, trackerItem } from "./tracker-fixtures";

describe("hidingReplacedComments", () => {
    const original = trackerComment({ id: "cm_1", body: "Use OAuth", created_at: 1 });
    const edit = trackerComment({ id: "cm_2", body: "Use OAuth with PKCE", created_at: 2, replaces: "cm_1" });

    it("leaves out the cancelled reply an edit replaces", () => {
        expect(hidingReplacedComments([original, edit]).map((c) => c.id)).toEqual(["cm_2"]);
    });

    it("keeps every comment when none replaces another", () => {
        const other = trackerComment({ id: "cm_3", body: "And another thing", created_at: 3 });
        expect(hidingReplacedComments([original, other]).map((c) => c.id)).toEqual(["cm_1", "cm_3"]);
    });

    it("keeps another person's reply even when a replaces names it", () => {
        const contributors = trackerComment({ id: "cm_c", contributor: { name: "bob", via: "user" } });
        const handedOver = trackerComment({ id: "cm_h", attribution: "bob" });
        const naming = [
            trackerComment({ id: "cm_7", replaces: "cm_c" }),
            trackerComment({ id: "cm_6", replaces: "cm_h" }),
        ];
        expect(hidingReplacedComments([contributors, handedOver, ...naming]).map((c) => c.id)).toEqual([
            "cm_c",
            "cm_h",
            "cm_7",
            "cm_6",
        ]);
    });

    it("only ever leaves out the user's own plain replies", () => {
        const agents = trackerComment({ id: "cm_a", author: "agent", body: "Noted" });
        const status = trackerComment({ id: "cm_s", kind: "status", body: "" });
        const naming = trackerComment({ id: "cm_9", replaces: "cm_a" });
        const namingStatus = trackerComment({ id: "cm_8", replaces: "cm_s" });
        expect(hidingReplacedComments([agents, status, naming, namingStatus]).map((c) => c.id)).toEqual([
            "cm_a",
            "cm_s",
            "cm_9",
            "cm_8",
        ]);
    });
});

describe("ItemDetail thread with an edited reply", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    let root: Root | undefined;
    let container: HTMLDivElement | undefined;
    afterEach(async () => {
        if (root) await act(async () => root!.unmount());
        container?.remove();
        root = undefined;
        container = undefined;
    });

    it("shows the edit alone, not the cancelled copy above it", async () => {
        const client = {
            seen: fakeSeen(),
            getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
        };
        container = document.createElement("div");
        document.body.append(container);
        await act(async () => {
            root = createRoot(container!);
            root.render(
                <ItemDetail
                    item={trackerItem()}
                    comments={[
                        trackerComment({ id: "cm_1", body: "Use OAuth", created_at: 1 }),
                        trackerComment({ id: "cm_2", body: "Use OAuth with PKCE", created_at: 2, replaces: "cm_1" }),
                    ]}
                    client={client as unknown as MatronJournalClient}
                    onBack={jest.fn()}
                />,
            );
        });
        const thread = container.querySelector(".mj_TrackerThread")?.textContent ?? "";
        expect(thread).toContain("Use OAuth with PKCE");
        expect(thread.replace("Use OAuth with PKCE", "")).not.toContain("Use OAuth");
    });
});
