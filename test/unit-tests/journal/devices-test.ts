/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../../../src/journal/api";
import {
    deviceCaption,
    deviceNameProblem,
    displayPairingCode,
    duplicateTagWarning,
    isPairUri,
    lagText,
    linkUri,
    normalizePairingCode,
    parsePairUri,
    sameOrigin,
    sortDevices,
    tagCharFromDraft,
} from "../../../src/journal/devices";
import type { DeviceDTO } from "../../../src/journal/types";

describe("device names", () => {
    it("refuses an empty name and one over 40 characters, after trimming", () => {
        expect(deviceNameProblem("   ")).toBe("Give the device a name.");
        expect(deviceNameProblem("a".repeat(41))).toBe("Names are at most 40 characters.");
        expect(deviceNameProblem(`  ${"a".repeat(40)}  `)).toBeUndefined();
        expect(deviceNameProblem("box-a")).toBeUndefined();
    });
});

describe("tag characters", () => {
    it("keeps only the first grapheme of the trimmed draft", () => {
        expect(tagCharFromDraft("  zq ")).toBe("z");
        expect(tagCharFromDraft("7")).toBe("7");
        expect(tagCharFromDraft("👍🏽x")).toBe("👍🏽");
    });

    it("clears to automatic (null) for a blank draft or one that renders as nothing", () => {
        expect(tagCharFromDraft("")).toBeNull();
        expect(tagCharFromDraft("   ")).toBeNull();
        expect(tagCharFromDraft("\u00ad")).toBeNull(); // soft hyphen
        expect(tagCharFromDraft("\u202e")).toBeNull(); // right-to-left override
        expect(tagCharFromDraft(`a${"\u0301".repeat(20)}`)).toBeNull(); // a combining stack over 16 scalars
    });

    it("warns when another agent box already shows the tag, ignoring case", () => {
        expect(duplicateTagWarning("a", ["A", "b"])).toBe("Another agent already uses the tag a");
        expect(duplicateTagWarning("az", ["a"])).toBe("Another agent already uses the tag a");
        expect(duplicateTagWarning("c", ["a", "b"])).toBeUndefined();
        expect(duplicateTagWarning("", ["a"])).toBeUndefined();
    });
});

describe("pairing codes", () => {
    it("normalises and formats sloppy input as the journal does", () => {
        expect(normalizePairingCode(" ktnm 3vq8 ")).toBe("KTNM3VQ8");
        // As the journal does it: only ASCII letters and digits survive, so a look-alike letter
        // from another script is dropped rather than sent.
        expect(normalizePairingCode("\u041aTNM-3VQ8")).toBe("TNM3VQ8");
        expect(displayPairingCode("ktnm3vq8")).toBe("KTNM-3VQ8");
        expect(displayPairingCode("ktn")).toBe("KTN");
        expect(displayPairingCode("ktnm-")).toBe("KTNM");
        expect(displayPairingCode("ktnm3")).toBe("KTNM-3");
    });

    it("unpacks a box's pairing link", () => {
        const parsed = parsePairUri("matron://pair?v=1&server=https%3A%2F%2Fchat.example.com&code=ktnm3vq8\n");
        expect(parsed).toEqual({ ok: true, server: new URL("https://chat.example.com"), code: "KTNM-3VQ8" });
        expect(isPairUri("MATRON://PAIR?v=1")).toBe(true);
        expect(isPairUri("matron://link?v=1")).toBe(false);
        expect(isPairUri("KTNM-3VQ8")).toBe(false);
    });

    it("refuses a future version, a cleartext remote server and a code outside the alphabet", () => {
        expect(parsePairUri("matron://pair?v=2&server=https://chat.example.com&code=KTNM3VQ8")).toEqual({
            ok: false,
            reason: "unsupported_version",
        });
        expect(parsePairUri("matron://pair?v=1&server=http://chat.example.com&code=KTNM3VQ8")).toMatchObject({
            ok: false,
            reason: "malformed",
        });
        expect(parsePairUri("matron://pair?v=1&server=http://localhost:8080&code=KTNM3VQ8")).toMatchObject({
            ok: true,
        });
        expect(parsePairUri("matron://pair?v=1&server=https://chat.example.com&code=AEIO3VQ8")).toMatchObject({
            ok: false,
        });
        expect(parsePairUri("matron://pair?server=https://chat.example.com&code=KTNM3VQ8")).toMatchObject({
            ok: false,
            reason: "malformed",
        });
    });

    it("compares servers by origin, ignoring the path and a default port", () => {
        expect(sameOrigin(new URL("https://Chat.Example.com/"), new URL("https://chat.example.com:443/base"))).toBe(
            true,
        );
        expect(sameOrigin(new URL("https://chat.example.com:8443"), new URL("https://chat.example.com"))).toBe(false);
    });
});

describe("link codes", () => {
    it("builds the sign-in QR payload the other apps scan", () => {
        expect(linkUri("https://chat.example.com", "KTNM-3VQ8")).toBe(
            "matron://link?v=1&server=https://chat.example.com&code=KTNM-3VQ8",
        );
        expect(linkUri("https://chat.example.com/base path", "KTNM-3VQ8")).toBe(
            "matron://link?v=1&server=https://chat.example.com/base%20path&code=KTNM-3VQ8",
        );
    });
});

describe("the device roster", () => {
    const device = (overrides: Partial<DeviceDTO>): DeviceDTO => ({
        device_id: 1,
        kind: "client",
        connected: false,
        is_self: false,
        ...overrides,
    });

    it("lists apps first, then agent boxes, each newest first", () => {
        const sorted = sortDevices([
            device({ device_id: 1, kind: "agent", created_at: 10 }),
            device({ device_id: 2, kind: "client", created_at: 5 }),
            device({ device_id: 3, kind: "agent", created_at: 30 }),
            device({ device_id: 4, kind: "client", created_at: 20 }),
        ]);
        expect(sorted.map((entry) => entry.device_id)).toEqual([4, 2, 3, 1]);
    });

    it("captions a device with its kind, last seen, lag and an agent box's tag", () => {
        expect(lagText(0)).toBe("Up to date");
        expect(lagText(1)).toBe("1 event behind");
        expect(lagText(12)).toBe("12 events behind");
        expect(deviceCaption(device({ kind: "agent", tag_char: "b", lag: 2 }))).toBe(
            "Agent · Last seen Never · 2 events behind · Tag b",
        );
        expect(deviceCaption(device({ kind: "client", tag_char: "b" }))).toBe("Client · Last seen Never · Up to date");
    });
});

describe("JournalApi device admin calls", () => {
    const fetchMock = jest.fn();

    const reply = (body: unknown, status = 200): Pick<Response, "status" | "headers" | "arrayBuffer"> => {
        const encoded = new NodeTextEncoder().encode(JSON.stringify(body));
        return {
            status,
            headers: new Headers({ "Content-Type": "application/json" }),
            arrayBuffer: async () => encoded.buffer,
        };
    };

    const sent = (index = 0): { url: string; method: string; body: unknown } => {
        const [url, init] = fetchMock.mock.calls[index];
        return { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    };

    beforeAll(() => {
        globalThis.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        delete (window as Window & { electron?: unknown }).electron;
    });

    const api = (): JournalApi => new JournalApi("https://journal.example", "token");

    it("renames, tags and revokes through the device routes", async () => {
        fetchMock.mockResolvedValue(reply({ ok: true }));
        await api().renameDevice(7, "box-b");
        await api().setDeviceTag(7, "b");
        await api().setDeviceTag(7, null);
        await api().revokeDevice(7);
        expect(sent(0)).toEqual({
            url: "https://journal.example/devices/7/rename",
            method: "POST",
            body: { name: "box-b" },
        });
        expect(sent(1)).toEqual({
            url: "https://journal.example/devices/7/tag",
            method: "POST",
            body: { tag_char: "b" },
        });
        // Clearing says so out loud: the journal refuses a missing key.
        expect(sent(2).body).toEqual({ tag_char: null });
        expect(sent(3)).toEqual({ url: "https://journal.example/devices/7/revoke", method: "POST", body: {} });
    });

    it("previews and approves a pairing code", async () => {
        fetchMock.mockResolvedValueOnce(reply({ requester_ip: "box-c.example.com", expires_in: 540 }));
        await expect(api().pairPreview("KTNM3VQ8")).resolves.toEqual({
            requester_ip: "box-c.example.com",
            expires_in: 540,
        });
        expect(sent(0)).toEqual({
            url: "https://journal.example/pair/preview",
            method: "POST",
            body: { pair_code: "KTNM3VQ8" },
        });

        fetchMock.mockResolvedValue(reply({ status: "approved" }));
        await api().pairApprove("KTNM3VQ8", "box-c", "c");
        await api().pairApprove("KTNM3VQ8", "box-c", null);
        expect(sent(1)).toEqual({
            url: "https://journal.example/pair/approve",
            method: "POST",
            body: { pair_code: "KTNM3VQ8", agent_name: "box-c", tag_char: "c" },
        });
        expect(sent(2).body).toEqual({ pair_code: "KTNM3VQ8", agent_name: "box-c" });
    });

    it("surfaces an already-approved code as a 409", async () => {
        fetchMock.mockResolvedValue(reply({ error: "conflict" }, 409));
        await expect(api().pairApprove("KTNM3VQ8", "box-c", null)).rejects.toMatchObject({ status: 409 });
    });

    it("starts, polls, approves and denies a link session", async () => {
        fetchMock.mockResolvedValueOnce(reply({ link_code: "KTNM-3VQ8", expires_in: 300 }));
        await expect(api().linkStart()).resolves.toEqual({ link_code: "KTNM-3VQ8", expires_in: 300 });
        expect(sent(0)).toEqual({ url: "https://journal.example/link/start", method: "POST", body: {} });

        fetchMock.mockResolvedValueOnce(reply({ status: "waiting", expires_in: 280 }));
        await expect(api().linkStatus()).resolves.toEqual({ status: "waiting", expires_in: 280 });
        fetchMock.mockResolvedValueOnce(
            reply({
                status: "claimed",
                device_name: "bob's laptop",
                requester_ip: "box-d.example.com",
                expires_in: 200,
            }),
        );
        await expect(api().linkStatus()).resolves.toEqual({
            status: "claimed",
            device_name: "bob's laptop",
            requester_ip: "box-d.example.com",
            expires_in: 200,
        });
        expect(sent(1)).toEqual({ url: "https://journal.example/link/status", method: "POST", body: {} });

        fetchMock.mockResolvedValue(reply({ status: "approved" }));
        await api().linkApprove("KTNM-3VQ8");
        await api().linkDeny("KTNM-3VQ8");
        expect(sent(3)).toEqual({
            url: "https://journal.example/link/approve",
            method: "POST",
            body: { link_code: "KTNM-3VQ8" },
        });
        expect(sent(4)).toEqual({
            url: "https://journal.example/link/deny",
            method: "POST",
            body: { link_code: "KTNM-3VQ8" },
        });
    });

    it("rejects a malformed link answer", async () => {
        fetchMock.mockResolvedValue(reply({ status: "something" }));
        await expect(api().linkStatus()).rejects.toBeInstanceOf(JournalApiError);
        fetchMock.mockResolvedValue(reply({ link_code: 4 }));
        await expect(api().linkStart()).rejects.toBeInstanceOf(JournalApiError);
    });

    it("keeps a device's tag, enrolment time and lag, and a never-connected device", async () => {
        fetchMock.mockResolvedValue(
            reply({
                devices: [
                    {
                        device_id: 9,
                        kind: "agent",
                        name: "box-e",
                        tag_char: "e",
                        created_at: 100,
                        cursor: 4,
                        lag: 3,
                        last_seen_at: null,
                        connected: false,
                        is_self: false,
                    },
                ],
            }),
        );
        const { devices } = await api().devices();
        expect(devices).toEqual([
            {
                device_id: 9,
                kind: "agent",
                name: "box-e",
                tag_char: "e",
                created_at: 100,
                lag: 3,
                connected: false,
                is_self: false,
            },
        ]);
    });
});
