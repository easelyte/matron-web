/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import type { ClientState, Conversation } from "../../../src/journal/types";

const conversation = (id: string, unread_count: number, parent_convo_id?: string): Conversation => ({
    id,
    title: id,
    session_state: "done",
    last_seq: 0,
    unread_count,
    snippet: "",
    created_at: 0,
    parent_convo_id,
    read_up_to_seq: 0,
});

interface ClientInternals {
    state: ClientState;
    emit(): void;
}

describe("subchat desktop badge", () => {
    afterEach(() => {
        delete (window as Window & { electron?: unknown }).electron;
    });

    it("counts roots and orphans but excludes linked children", () => {
        const send = jest.fn();
        (window as Window & { electron?: { send: typeof send } }).electron = { send };
        const client = new MatronJournalClient();
        const internals = client as unknown as ClientInternals;
        internals.state = {
            ...client.getSnapshot(),
            conversations: [
                conversation("root", 2),
                conversation("root:sub:linked", 8, "root"),
                conversation("missing:sub:orphan", 4, "missing"),
            ],
        };

        internals.emit();

        expect(send).toHaveBeenCalledWith("setBadgeCount", 6);
    });
});
