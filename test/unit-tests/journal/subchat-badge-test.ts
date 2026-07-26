/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { MatronJournalClient } from "../../../src/journal/client";
import type { ClientState, Conversation } from "../../../src/journal/types";

const conversation = (
    id: string,
    unread_count: number,
    parent_convo_id?: string,
    session_state = "done",
): Conversation => ({
    id,
    title: id,
    session_state,
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

    it("excludes a hidden done child of an archived parent so the badge can't outlive its rows (#536)", () => {
        // Blocker 1: a done child of an archived parent renders NO sidebar row and has no
        // Mark-all to clear it, so it must contribute zero — otherwise a stuck, untargetable
        // unread badge persists. The archived parent itself is likewise not counted (no Active
        // row / no Mark-all). Only the live top-level root contributes.
        const send = jest.fn();
        (window as Window & { electron?: { send: typeof send } }).electron = { send };
        const client = new MatronJournalClient();
        const internals = client as unknown as ClientInternals;
        internals.state = {
            ...client.getSnapshot(),
            conversations: [
                conversation("live", 3),
                conversation("arch", 5),
                conversation("arch:sub:done", 8, "arch"), // done child of the archived parent
            ],
            archivedIds: new Set(["arch"]),
        };

        internals.emit();

        expect(send).toHaveBeenCalledWith("setBadgeCount", 3);
    });

    it("counts a RUNNING child of an archived parent (top-level transient) but not its done sibling (#536)", () => {
        const send = jest.fn();
        (window as Window & { electron?: { send: typeof send } }).electron = { send };
        const client = new MatronJournalClient();
        const internals = client as unknown as ClientInternals;
        internals.state = {
            ...client.getSnapshot(),
            conversations: [
                conversation("arch", 5),
                conversation("arch:sub:run", 7, "arch", "running"), // running → renders top-level
                conversation("arch:sub:done", 9, "arch"), // done → hidden
            ],
            archivedIds: new Set(["arch"]),
        };

        internals.emit();

        expect(send).toHaveBeenCalledWith("setBadgeCount", 7);
    });
});
