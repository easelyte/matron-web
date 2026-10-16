/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApiError } from "../api";
import { favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../client";
import { MatronApp } from "../components";
import { LINK_POLL_MS, PAIR_CLAIM_POLL_MS, PAIR_PREVIEW_DEBOUNCE_MS } from "../DevicesSettings";
import { setTheme } from "../theme";
import type { ClientState, Conversation, DeviceDTO, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://chat.example.com",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};
const CONVERSATION: Conversation = {
    id: "c1",
    title: "One",
    session_state: "idle",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 1,
};

const THIS_BROWSER: DeviceDTO = {
    device_id: 1,
    kind: "client",
    name: "alice's browser",
    created_at: 100,
    lag: 0,
    connected: true,
    is_self: true,
};
const PHONE: DeviceDTO = {
    device_id: 2,
    kind: "client",
    name: "alice's phone",
    created_at: 200,
    lag: 3,
    connected: false,
    is_self: false,
};
const BOX_A: DeviceDTO = {
    device_id: 10,
    kind: "agent",
    name: "box-a",
    tag_char: "a",
    created_at: 50,
    connected: true,
    is_self: false,
};
const BOX_B: DeviceDTO = {
    device_id: 11,
    kind: "agent",
    name: "box-b",
    tag_char: null,
    created_at: 60,
    connected: false,
    is_self: false,
};

type DevicesApi = {
    devices: jest.Mock<Promise<{ devices: DeviceDTO[] }>, []>;
    defaults: jest.Mock;
    renameDevice: jest.Mock<Promise<void>, [number, string]>;
    setDeviceTag: jest.Mock<Promise<void>, [number, string | null]>;
    revokeDevice: jest.Mock<Promise<void>, [number]>;
    pairPreview: jest.Mock;
    pairApprove: jest.Mock<Promise<void>, [string, string, string | null]>;
    linkStart: jest.Mock;
    linkStatus: jest.Mock;
    linkApprove: jest.Mock<Promise<void>, [string]>;
    linkDeny: jest.Mock<Promise<void>, [string]>;
};

function signedInClient(devices: DeviceDTO[]): { client: MatronJournalClient; api: DevicesApi } {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: "c1",
        events: [],
        pendingMessages: [],
        connection: "online",
        archivedIds: new Set(),
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    let roster = [...devices];
    const api: DevicesApi = {
        devices: jest.fn(() => Promise.resolve({ devices: roster })),
        defaults: jest.fn(() => new Promise(() => undefined)),
        renameDevice: jest.fn(async (id: number, name: string) => {
            roster = roster.map((device) => (device.device_id === id ? { ...device, name } : device));
        }),
        setDeviceTag: jest.fn(async (id: number, tag: string | null) => {
            roster = roster.map((device) => (device.device_id === id ? { ...device, tag_char: tag } : device));
        }),
        revokeDevice: jest.fn(async (id: number) => {
            roster = roster.filter((device) => device.device_id !== id);
        }),
        pairPreview: jest.fn(),
        pairApprove: jest.fn(async (_code: string, _name: string, _tag: string | null) => undefined),
        linkStart: jest.fn(),
        linkStatus: jest.fn(),
        linkApprove: jest.fn(async (_code: string) => undefined),
        linkDeny: jest.fn(async (_code: string) => undefined),
    };
    (client as unknown as { api: DevicesApi }).api = api;
    return {
        client,
        api: Object.assign(api, {
            // Lets a test add a device the way a box collecting its token would.
            add: (device: DeviceDTO) => (roster = [...roster, device]),
        }),
    };
}

describe("Settings → Devices", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
        });
    });

    beforeEach(() => {
        localStorage.clear();
        setTheme(null);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    async function openSettings(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
    }

    const settings = (): HTMLElement | null => document.querySelector<HTMLElement>(".mj_SettingsSheet");
    const row = (id: number): HTMLElement => document.querySelector<HTMLElement>(`[data-device="${id}"]`)!;
    const action = (id: number, name: string): HTMLButtonElement | null =>
        row(id).querySelector<HTMLButtonElement>(`[data-device-action="${name}"]`);
    const deviceSheet = (): HTMLElement | null => document.querySelector<HTMLElement>(".mj_DeviceSheet");
    const button = (label: string): HTMLButtonElement =>
        [...deviceSheet()!.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === label,
        )!;

    async function type(input: HTMLInputElement, value: string): Promise<void> {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    }

    async function advance(ms: number): Promise<void> {
        await act(async () => {
            await jest.advanceTimersByTimeAsync(ms);
        });
    }

    it("lists apps first, then agent boxes, each with its actions", async () => {
        const { client } = signedInClient([BOX_A, THIS_BROWSER, BOX_B, PHONE]);
        await openSettings(client);
        const ids = [...document.querySelectorAll<HTMLElement>("[data-device]")].map((el) => el.dataset.device);
        expect(ids).toEqual(["2", "1", "11", "10"]);
        expect(row(1).textContent).toContain("This device");
        expect(row(2).textContent).not.toContain("This device");
        expect(row(2).textContent).toContain("3 events behind");
        expect(row(10).textContent).toContain("Tag a");
        // Tag… only on agent boxes; the device in use is signed out rather than revoked.
        expect(action(10, "tag")).not.toBeNull();
        expect(action(2, "tag")).toBeNull();
        expect(action(1, "revoke")!.textContent).toBe("Sign Out…");
        expect(action(2, "revoke")!.textContent).toBe("Revoke…");
    });

    it("renames a device and re-reads the roster", async () => {
        const { client, api } = signedInClient([THIS_BROWSER, BOX_A]);
        await openSettings(client);
        await act(async () => action(10, "rename")!.click());
        const input = deviceSheet()!.querySelector<HTMLInputElement>("#mj-device-rename")!;
        expect(input.value).toBe("box-a");
        await type(input, "   ");
        expect(button("Rename").disabled).toBe(true);
        await type(input, "  box-z ");
        await act(async () => button("Rename").click());
        expect(api.renameDevice).toHaveBeenCalledWith(10, "box-z");
        expect(deviceSheet()).toBeNull();
        expect(row(10).textContent).toContain("box-z");
    });

    it("sets and clears an agent box's tag character", async () => {
        const { client, api } = signedInClient([THIS_BROWSER, BOX_A]);
        await openSettings(client);
        await act(async () => action(10, "tag")!.click());
        const input = deviceSheet()!.querySelector<HTMLInputElement>("#mj-device-tag")!;
        expect(input.value).toBe("a");
        await type(input, " zq");
        await act(async () => button("Save").click());
        expect(api.setDeviceTag).toHaveBeenLastCalledWith(10, "z");
        expect(row(10).textContent).toContain("Tag z");

        await act(async () => action(10, "tag")!.click());
        await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-device-tag")!, "");
        await act(async () => button("Save").click());
        expect(api.setDeviceTag).toHaveBeenLastCalledWith(10, null);
        expect(row(10).querySelector(".mj_DevicesList_caption")!.textContent).not.toContain("Tag");
    });

    it("asks before revoking another device, and does nothing on Cancel", async () => {
        const { client, api } = signedInClient([THIS_BROWSER, PHONE]);
        await openSettings(client);
        await act(async () => action(2, "revoke")!.click());
        expect(deviceSheet()!.querySelector("h2")!.textContent).toBe("Revoke “alice's phone”?");
        expect(deviceSheet()!.textContent).toContain("There's no undo");
        await act(async () => button("Cancel").click());
        expect(api.revokeDevice).not.toHaveBeenCalled();
        expect(row(2)).not.toBeNull();

        await act(async () => action(2, "revoke")!.click());
        await act(async () => button("Revoke").click());
        expect(api.revokeDevice).toHaveBeenCalledWith(2);
        expect(document.querySelector('[data-device="2"]')).toBeNull();
    });

    it("warns that revoking the device in use signs it out, then signs out", async () => {
        const { client, api } = signedInClient([THIS_BROWSER, PHONE]);
        const logout = jest.spyOn(client, "logout").mockResolvedValue(undefined);
        await openSettings(client);
        await act(async () => action(1, "revoke")!.click());
        const sheet = deviceSheet()!;
        expect(sheet.querySelector("h2")!.textContent).toBe("Sign out this device?");
        expect(sheet.querySelector("[data-self-warning]")!.textContent).toContain(
            "This is the device you are using now",
        );
        // Focus starts on Cancel, so Enter does not sign out by accident.
        expect(document.activeElement).toBe(button("Cancel"));
        // Announced as an interrupting confirmation, with the warning read alongside the title.
        const dialog = sheet.closest<HTMLElement>('[role="alertdialog"]')!;
        expect(dialog.getAttribute("aria-describedby")).toBe("mj-device-revoke-body");
        expect(document.getElementById("mj-device-revoke-body")).toBe(sheet.querySelector("[data-self-warning]"));
        await act(async () => button("Sign Out").click());
        expect(api.revokeDevice).toHaveBeenCalledWith(1);
        expect(logout).toHaveBeenCalledWith("This device was revoked. Sign in again to continue.");
    });

    it("never revokes on a form submit (Enter), only on the button itself", async () => {
        const { client, api } = signedInClient([THIS_BROWSER, PHONE]);
        await openSettings(client);
        await act(async () => action(1, "revoke")!.click());
        await act(async () => {
            deviceSheet()!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        expect(api.revokeDevice).not.toHaveBeenCalled();
        expect(deviceSheet()).not.toBeNull();
    });

    it("treats a device already revoked elsewhere as revoked", async () => {
        const { client, api } = signedInClient([THIS_BROWSER, PHONE]);
        api.revokeDevice.mockRejectedValueOnce(new JournalApiError("gone", 404, "not_found"));
        await openSettings(client);
        await act(async () => action(2, "revoke")!.click());
        await act(async () => button("Revoke").click());
        expect(deviceSheet()).toBeNull();
        expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    it("closes only the device sheet on Escape, leaving Settings open", async () => {
        const { client } = signedInClient([THIS_BROWSER, PHONE]);
        await openSettings(client);
        await act(async () => action(2, "rename")!.click());
        expect(deviceSheet()).not.toBeNull();
        await act(async () => {
            document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(deviceSheet()).toBeNull();
        expect(settings()).not.toBeNull();
    });

    describe("Add Agent", () => {
        it("previews a typed code, shows who is asking, approves, and waits for the box", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER, BOX_A]);
            api.pairPreview.mockResolvedValue({ requester_ip: "box-c.example.com", expires_in: 540 });
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-agent"]')!.click());
            const code = deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-code")!;
            await type(code, "ktnm 3vq8");
            expect(code.value).toBe("KTNM-3VQ8");
            // No approve before the preview has shown who is asking.
            expect(deviceSheet()!.textContent).not.toContain("Approve");
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(api.pairPreview).toHaveBeenCalledWith("KTNM3VQ8");
            expect(deviceSheet()!.querySelector("[data-pair-preview]")!.textContent).toContain("box-c.example.com");
            expect(deviceSheet()!.textContent).toContain("Code expires in 9:00");
            expect(button("Approve").disabled).toBe(true);

            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-name")!, "box-c");
            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-tag")!, "A");
            expect(deviceSheet()!.textContent).toContain("Another agent already uses the tag A");
            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-tag")!, "c");
            await act(async () => button("Approve").click());
            expect(api.pairApprove).toHaveBeenCalledWith("KTNM3VQ8", "box-c", "c");
            expect(deviceSheet()!.textContent).toContain("Waiting for the agent to connect…");
            expect(document.activeElement).toBe(button("Close"));

            (api as unknown as { add: (device: DeviceDTO) => void }).add({
                device_id: 12,
                kind: "agent",
                name: "box-c",
                connected: true,
                is_self: false,
            });
            await advance(PAIR_CLAIM_POLL_MS);
            expect(deviceSheet()!.textContent).toContain("box-c is connected.");
            expect(document.activeElement).toBe(button("Done"));
        });

        it("refuses a pasted pairing link for another server without sending it", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.pairPreview.mockResolvedValue({ requester_ip: "box-c.example.com", expires_in: 540 });
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-agent"]')!.click());
            const code = deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-code")!;
            await type(code, "matron://pair?v=1&server=https%3A%2F%2Fother.example.com&code=KTNM3VQ8");
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(api.pairPreview).not.toHaveBeenCalled();
            expect(code.value).toBe("");
            expect(deviceSheet()!.querySelector('[role="alert"]')!.textContent).toBe(
                "This link is for other.example.com, you're signed in to chat.example.com.",
            );

            await type(code, "matron://pair?v=1&server=https%3A%2F%2Fchat.example.com&code=KTNM3VQ8");
            expect(code.value).toBe("KTNM-3VQ8");
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(api.pairPreview).toHaveBeenCalledWith("KTNM3VQ8");
        });

        it("previews again when the same pairing link is pasted after a failed check", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.pairPreview
                .mockRejectedValueOnce(new JournalApiError("offline", 0))
                .mockResolvedValue({ requester_ip: "box-c.example.com", expires_in: 540 });
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-agent"]')!.click());
            const code = deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-code")!;
            const link = "matron://pair?v=1&server=https%3A%2F%2Fchat.example.com&code=KTNM3VQ8";
            await type(code, link);
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(deviceSheet()!.querySelector('[role="alert"]')!.textContent).toBe(
                "Couldn't check that code — try again.",
            );
            await type(code, link);
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(api.pairPreview).toHaveBeenCalledTimes(2);
            expect(deviceSheet()!.querySelector("[data-pair-preview]")).not.toBeNull();
        });

        it("says why a code longer than eight characters is not checked", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-agent"]')!.click());
            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-code")!, "KTNM3VQ8X");
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(api.pairPreview).not.toHaveBeenCalled();
            expect(deviceSheet()!.textContent).toContain("Pairing codes are 8 characters");
        });

        it("holds Approve back for a name over 40 characters", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.pairPreview.mockResolvedValue({ requester_ip: "box-c.example.com", expires_in: 540 });
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-agent"]')!.click());
            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-code")!, "KTNM3VQ8");
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-name")!, "b".repeat(41));
            expect(button("Approve").disabled).toBe(true);
            expect(deviceSheet()!.textContent).toContain("Names are at most 40 characters.");
        });

        it("says so when the code is unknown or expired", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.pairPreview.mockRejectedValue(new JournalApiError("gone", 404, "not_found"));
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="add-agent"]')!.click());
            await type(deviceSheet()!.querySelector<HTMLInputElement>("#mj-add-agent-code")!, "KTNM3VQ8");
            await advance(PAIR_PREVIEW_DEBOUNCE_MS);
            expect(deviceSheet()!.querySelector('[role="alert"]')!.textContent).toBe(
                "Code not recognized or expired. Get a fresh code from the box and try again.",
            );
        });
    });

    describe("Link a Device", () => {
        async function openLink(client: MatronJournalClient): Promise<void> {
            await openSettings(client);
            await act(async () => document.querySelector<HTMLButtonElement>('[data-action="link-device"]')!.click());
        }

        it("shows the code and its QR only in the sheet, then approves the device that claims it", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.linkStart.mockResolvedValue({ link_code: "KTNM-3VQ8", expires_in: 300 });
            api.linkStatus.mockResolvedValueOnce({ status: "waiting", expires_in: 290 }).mockResolvedValue({
                status: "claimed",
                device_name: "bob's laptop",
                requester_ip: "box-d.example.com",
                expires_in: 280,
            });
            await openLink(client);
            const sheet = deviceSheet()!;
            expect(sheet.querySelector("[data-link-code]")!.textContent).toBe("KTNM-3VQ8");
            expect(sheet.querySelector("svg.mj_QrCode")).not.toBeNull();
            // The code appears nowhere outside the Link a Device sheet.
            expect(settings()!.textContent).not.toContain("KTNM");
            expect(document.body.textContent!.split("KTNM-3VQ8").length - 1).toBe(1);

            await advance(LINK_POLL_MS);
            expect(deviceSheet()!.textContent).not.toContain("wants to sign in");
            await advance(LINK_POLL_MS);
            expect(deviceSheet()!.textContent).toContain(
                "bob's laptop at box-d.example.com wants to sign in to your account.",
            );
            await act(async () => button("Approve").click());
            expect(api.linkApprove).toHaveBeenCalledWith("KTNM-3VQ8");
            expect(deviceSheet()!.textContent).toContain("Approved — finishing sign-in on the other device.");
            const polls = api.linkStatus.mock.calls.length;
            await advance(LINK_POLL_MS * 3);
            expect(api.linkStatus).toHaveBeenCalledTimes(polls);
        });

        it("shows a fresh code when the old one expires, and stops asking once closed", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.linkStart
                .mockResolvedValueOnce({ link_code: "KTNM-3VQ8", expires_in: 300 })
                .mockResolvedValueOnce({ link_code: "BCDF-GHJK", expires_in: 300 });
            api.linkStatus
                .mockRejectedValueOnce(new JournalApiError("gone", 404, "not_found"))
                .mockResolvedValue({ status: "waiting", expires_in: 300 });
            await openLink(client);
            await advance(LINK_POLL_MS);
            expect(deviceSheet()!.querySelector("[data-link-code]")!.textContent).toBe("BCDF-GHJK");

            const listed = api.devices.mock.calls.length;
            await act(async () => deviceSheet()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
            expect(deviceSheet()).toBeNull();
            // A device approved meanwhile shows without a manual Refresh.
            expect(api.devices.mock.calls.length).toBe(listed + 1);
            const polls = api.linkStatus.mock.calls.length;
            await advance(LINK_POLL_MS * 3);
            expect(api.linkStatus).toHaveBeenCalledTimes(polls);
        });

        it("mints no new code once closed while an approve is still out", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.linkStart.mockResolvedValue({ link_code: "KTNM-3VQ8", expires_in: 300 });
            api.linkStatus.mockResolvedValue({
                status: "claimed",
                device_name: "bob's laptop",
                requester_ip: "box-d.example.com",
                expires_in: 280,
            });
            let answer!: (error: unknown) => void;
            api.linkApprove.mockImplementation(() => new Promise<void>((_resolve, reject) => (answer = reject)));
            await openLink(client);
            await advance(LINK_POLL_MS);
            await act(async () => button("Approve").click());
            await act(async () => deviceSheet()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
            expect(deviceSheet()).toBeNull();
            // The code expired meanwhile: with the sheet open this would show a fresh one.
            await act(async () => answer(new JournalApiError("gone", 404, "not_found")));
            const polls = api.linkStatus.mock.calls.length;
            await advance(LINK_POLL_MS * 3);
            expect(api.linkStart).toHaveBeenCalledTimes(1);
            expect(api.linkStatus).toHaveBeenCalledTimes(polls);
        });

        it("tells a web user that link codes are for the apps", async () => {
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.linkStart.mockResolvedValue({ link_code: "KTNM-3VQ8", expires_in: 300 });
            api.linkStatus.mockReturnValue(new Promise(() => undefined));
            await openLink(client);
            expect(deviceSheet()!.textContent).toContain("the web app doesn't take link codes");
        });

        it("denies a device that claims the code", async () => {
            jest.useFakeTimers();
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.linkStart.mockResolvedValue({ link_code: "KTNM-3VQ8", expires_in: 300 });
            api.linkStatus.mockResolvedValue({
                status: "claimed",
                device_name: "unknown laptop",
                requester_ip: "box-e.example.com",
                expires_in: 280,
            });
            await openLink(client);
            await advance(LINK_POLL_MS);
            await act(async () => button("Deny").click());
            expect(api.linkDeny).toHaveBeenCalledWith("KTNM-3VQ8");
            expect(api.linkApprove).not.toHaveBeenCalled();
            expect(deviceSheet()!.textContent).toContain("Denied. No device was signed in.");
        });

        it("says when the journal cannot link devices", async () => {
            const { client, api } = signedInClient([THIS_BROWSER]);
            api.linkStart.mockRejectedValue(new JournalApiError("nope", 404, "not_found"));
            await openLink(client);
            expect(deviceSheet()!.textContent).toContain("Server doesn't support device linking yet.");
        });
    });
});
