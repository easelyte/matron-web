/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { inertMediaType, JournalApi, JournalApiError } from "../../../src/journal/api";
import { MatronJournalClient } from "../../../src/journal/client";
import { JournalConnection } from "../../../src/journal/connection";
import { JournalDatabase } from "../../../src/journal/database";
import { isImageAttachment } from "../../../src/journal/tracker/ItemAttachments";
import { type Session } from "../../../src/journal/types";

const SESSION_KEY = "matron_journal_session_v1";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token-a",
    deviceId: 7,
    userId: 2,
    username: "alice",
};

function fakeDatabase(): Record<string, jest.Mock> {
    return {
        expireToolLogs: jest.fn().mockResolvedValue(undefined),
        cursor: jest.fn().mockResolvedValue(1),
        conversations: jest.fn().mockResolvedValue([]),
        replaceWithSnapshot: jest.fn().mockResolvedValue(undefined),
        events: jest.fn().mockResolvedValue([]),
        outbox: jest.fn().mockResolvedValue([]),
        putHistory: jest.fn().mockResolvedValue(undefined),
        markLocallyRead: jest.fn().mockResolvedValue(undefined),
        reconcilePersistedOwnMessages: jest.fn().mockResolvedValue([]),
        reset: jest.fn().mockResolvedValue(undefined),
        close: jest.fn(),
    };
}

async function signedIn(): Promise<MatronJournalClient> {
    jest.spyOn(JournalDatabase, "open").mockResolvedValue(fakeDatabase() as unknown as JournalDatabase);
    jest.spyOn(JournalApi.prototype, "snapshot").mockResolvedValue({ seq: 2, conversations: [] });
    jest.spyOn(JournalApi.prototype, "messages").mockResolvedValue({ events: [] });
    jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);
    jest.spyOn(JournalConnection.prototype, "stop").mockImplementation(() => undefined);
    localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    const client = new MatronJournalClient();
    await (client as unknown as { startSession(session: Session): Promise<void> }).startSession(SESSION);
    return client;
}

describe("Sign out", () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("revokes this device on the journal before signing out locally", async () => {
        const client = await signedIn();
        const revoke = jest.spyOn(JournalApi.prototype, "revokeDevice").mockResolvedValue(undefined);

        await client.signOut();

        expect(revoke).toHaveBeenCalledWith(7);
        expect(client.getSnapshot().phase).toBe("signed-out");
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it("still signs out when the journal refuses or cannot be reached", async () => {
        const client = await signedIn();
        jest.spyOn(JournalApi.prototype, "revokeDevice").mockRejectedValue(new JournalApiError("offline", 0));

        await client.signOut();

        expect(client.getSnapshot().phase).toBe("signed-out");
    });

    it("does not wait on a journal that never answers", async () => {
        const client = await signedIn();
        jest.useFakeTimers();
        jest.spyOn(JournalApi.prototype, "revokeDevice").mockReturnValue(new Promise(() => undefined));

        const done = client.signOut();
        await jest.advanceTimersByTimeAsync(3000);
        await done;

        expect(client.getSnapshot().phase).toBe("signed-out");
    });

    it("signs this tab out when another tab signs out", async () => {
        const client = await signedIn();

        localStorage.removeItem(SESSION_KEY);
        window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY, newValue: null }));
        await Promise.resolve();

        expect(client.getSnapshot().phase).toBe("signed-out");
    });

    it("signs this tab out when another tab signs in as someone else", async () => {
        const client = await signedIn();

        const other = { ...SESSION, token: "token-b", userId: 3, username: "bob" };
        localStorage.setItem(SESSION_KEY, JSON.stringify(other));
        window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY, newValue: JSON.stringify(other) }));
        await Promise.resolve();

        expect(client.getSnapshot().phase).toBe("signed-out");
    });

    it("keeps this tab signed in when the stored session is unchanged", async () => {
        const client = await signedIn();

        window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY, newValue: JSON.stringify(SESSION) }));
        await Promise.resolve();

        expect(client.getSnapshot().phase).toBe("signed-in");
    });
});

describe("media blob types", () => {
    it.each([
        ["image/png", "image/png"],
        ["IMAGE/JPEG; charset=binary", "image/jpeg"],
        ["audio/mp4", "audio/mp4"],
        ["audio/webm;codecs=opus", "audio/webm;codecs=opus"],
        ["video/mp4", "video/mp4"],
        ["image/svg+xml", "application/octet-stream"],
        ["text/html", "application/octet-stream"],
        ["application/xhtml+xml", "application/octet-stream"],
        ["text/xml", "application/octet-stream"],
        ["application/pdf", "application/octet-stream"],
        ["", "application/octet-stream"],
        [null, "application/octet-stream"],
    ])("keeps only a type that can never run as a page: %p", (sent, kept) => {
        expect(inertMediaType(sent)).toBe(kept);
    });

    it("types a fetched blob with the inert type, whatever the journal sent", async () => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
        const body = new NodeTextEncoder().encode("<svg/>");
        const fetchMock = jest.fn().mockResolvedValue({
            status: 200,
            headers: new Headers({ "Content-Type": "image/svg+xml" }),
            arrayBuffer: async () => body.buffer,
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const blob = await new JournalApi("https://journal.example", "token").media("m1");

        expect(blob.type).toBe("application/octet-stream");
        expect(String(fetchMock.mock.calls[0][0])).toBe("https://journal.example/media/m1");
    });

    it.each(["", ".", ".."])("refuses a media id that is not a single path segment: %p", async (mediaId) => {
        const fetchMock = jest.fn();
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        await expect(new JournalApi("https://journal.example", "token").media(mediaId)).rejects.toMatchObject({
            status: 404,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows an SVG tracker attachment as a file, not an inline image", () => {
        const attachment = { blob_ref: "b", name: "logo.svg", mime: "image/svg+xml", size: 10 };
        expect(isImageAttachment(attachment as Parameters<typeof isImageAttachment>[0])).toBe(false);
        expect(isImageAttachment({ ...attachment, mime: "image/png" } as Parameters<typeof isImageAttachment>[0])).toBe(
            true,
        );
    });
});
