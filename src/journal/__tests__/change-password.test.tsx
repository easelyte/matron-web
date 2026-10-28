/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApi, JournalApiError } from "../api";
import { ChangePassword, changePasswordFailure, passwordChangedMessage, passwordProblem } from "../ChangePassword";
import { MatronJournalClient } from "../client";
import { DevicesSettings } from "../DevicesSettings";
import { SecuritySettings } from "../TwoFactor";
import type { ClientState, Session } from "../types";

function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

const click = async (element: Element | null): Promise<void> => {
    expect(element).not.toBeNull();
    await act(async () => (element as HTMLElement).click());
};

const submitForm = async (): Promise<void> => {
    const form = document.body.querySelector(".mj_ChangePasswordSheet");
    expect(form).not.toBeNull();
    await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
};

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
    Object.defineProperty(globalThis, "TextDecoder", { value: NodeTextDecoder, configurable: true });
});

beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
});

describe("change password: rules and wording", () => {
    it("checks length, then the match, then that it differs from the current one", () => {
        expect(passwordProblem("old-secret", "short", "short")).toBe("Use at least 8 characters.");
        expect(passwordProblem("old-secret", "new-secret", "new-secreT")).toBe("The new passwords don't match.");
        expect(passwordProblem("old-secret", "old-secret", "old-secret")).toBe(
            "Choose a password different from your current one.",
        );
        expect(passwordProblem("old-secret", "new-secret", "new-secret")).toBeUndefined();
    });

    it("words each refusal", () => {
        expect(changePasswordFailure(new JournalApiError("x", 401, "bad_password"))).toBe(
            "That password is incorrect.",
        );
        expect(changePasswordFailure(new JournalApiError("x", 400, "weak_password"))).toBe(
            "Use at least 8 characters.",
        );
        expect(changePasswordFailure(new JournalApiError("x", 429, "locked_out", 61))).toBe(
            "Too many attempts. Try again in 2 minutes.",
        );
        expect(changePasswordFailure(new JournalApiError("x", 429, "locked_out", 5))).toBe(
            "Too many attempts. Try again in 1 minute.",
        );
        expect(changePasswordFailure(new JournalApiError("offline", 0))).toBe(
            "Couldn't reach the journal. Check your connection and try again.",
        );
        expect(changePasswordFailure(new JournalApiError("The journal server returned HTTP 500.", 500))).toBe(
            "The journal server returned HTTP 500.",
        );
    });

    it("counts the devices it signed out", () => {
        expect(passwordChangedMessage(0)).toBe("Password changed.");
        expect(passwordChangedMessage(1)).toBe("Password changed. Signed out of 1 other device.");
        expect(passwordChangedMessage(3)).toBe("Password changed. Signed out of 3 other devices.");
    });
});

describe("Settings → Security → Change Password…", () => {
    function fakeClient(result: { signed_out: number } | Error = { signed_out: 2 }) {
        return {
            changePassword: jest.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))),
        };
    }

    async function open(client: ReturnType<typeof fakeClient>, onChanged?: (n: number) => void): Promise<void> {
        await act(async () =>
            root.render(<ChangePassword client={client as unknown as MatronJournalClient} onChanged={onChanged} />),
        );
        await click($("[data-action=change-password]"));
    }

    async function fill(current: string, next: string, confirm: string): Promise<void> {
        await act(async () => type($<HTMLInputElement>("#mj-change-password-current")!, current));
        await act(async () => type($<HTMLInputElement>("#mj-change-password-new")!, next));
        await act(async () => type($<HTMLInputElement>("#mj-change-password-confirm")!, confirm));
    }

    const submitButton = (): HTMLButtonElement => $<HTMLButtonElement>(".mj_ChangePasswordSheet button[type=submit]")!;

    it("asks for the passwords with autofill hints, signing out other devices by default", async () => {
        await open(fakeClient());
        expect($<HTMLInputElement>("#mj-change-password-current")!.autocomplete).toBe("current-password");
        expect($<HTMLInputElement>("#mj-change-password-new")!.autocomplete).toBe("new-password");
        expect($<HTMLInputElement>("#mj-change-password-confirm")!.autocomplete).toBe("new-password");
        for (const id of ["current", "new", "confirm"]) {
            expect($<HTMLInputElement>(`#mj-change-password-${id}`)!.type).toBe("password");
        }
        expect($<HTMLInputElement>("[data-sign-out-others]")!.checked).toBe(true);
        expect($(".mj_ChangePasswordSheet")!.textContent).toContain("Your agent boxes stay connected.");
    });

    it("keeps Change Password off until every field is filled", async () => {
        await open(fakeClient());
        expect(submitButton().disabled).toBe(true);
        await act(async () => type($<HTMLInputElement>("#mj-change-password-current")!, "old-secret"));
        await act(async () => type($<HTMLInputElement>("#mj-change-password-new")!, "new-secret"));
        expect(submitButton().disabled).toBe(true);
        await act(async () => type($<HTMLInputElement>("#mj-change-password-confirm")!, "new-secret"));
        expect(submitButton().disabled).toBe(false);
    });

    it.each([
        ["old-secret", "short", "short", "Use at least 8 characters."],
        ["old-secret", "new-secret", "new-secrets", "The new passwords don't match."],
        ["old-secret", "old-secret", "old-secret", "Choose a password different from your current one."],
    ])("checks %s / %s / %s before sending", async (current, next, confirm, message) => {
        const client = fakeClient();
        await open(client);
        await fill(current, next, confirm);
        await submitForm();
        expect($("[role=alert]")?.textContent).toBe(message);
        expect(client.changePassword).not.toHaveBeenCalled();
    });

    it("changes it, closes the sheet, says how many devices were signed out and tells Settings", async () => {
        const client = fakeClient({ signed_out: 2 });
        const onChanged = jest.fn();
        await open(client, onChanged);
        await fill("old-secret", "new-secret", "new-secret");
        await submitForm();
        expect(client.changePassword).toHaveBeenCalledWith("old-secret", "new-secret", true);
        expect($(".mj_ChangePasswordSheet")).toBeNull();
        expect($("[data-change-password] [role=status]")?.textContent).toBe(
            "Password changed. Signed out of 2 other devices.",
        );
        expect(onChanged).toHaveBeenCalledWith(2);

        // Opening it again starts empty: nothing typed was kept.
        await click($("[data-action=change-password]"));
        expect($<HTMLInputElement>("#mj-change-password-current")!.value).toBe("");
        expect($<HTMLInputElement>("#mj-change-password-new")!.value).toBe("");
    });

    it("reports a change that finishes after its sheet closed, without closing a newer sheet", async () => {
        let finish!: (result: { signed_out: number }) => void;
        const client = {
            changePassword: jest.fn(
                () =>
                    new Promise<{ signed_out: number }>((resolve) => {
                        finish = resolve;
                    }),
            ),
        };
        const onChanged = jest.fn();
        await open(client, onChanged);
        await fill("old-secret", "new-secret", "new-secret");
        await submitForm();
        await click($(".mj_ChangePasswordSheet button[type=button]")); // Cancel while it runs
        expect($(".mj_ChangePasswordSheet")).toBeNull();
        await click($("[data-action=change-password]"));
        expect($(".mj_ChangePasswordSheet")).not.toBeNull();

        await act(async () => finish({ signed_out: 1 }));
        expect($(".mj_ChangePasswordSheet")).not.toBeNull();
        expect(onChanged).toHaveBeenCalledWith(1);
        expect($("[data-change-password] [role=status]")?.textContent).toBe(
            "Password changed. Signed out of 1 other device.",
        );
    });

    it("sends the flag off when unticked", async () => {
        const client = fakeClient({ signed_out: 0 });
        await open(client);
        await click($("[data-sign-out-others]"));
        await fill("old-secret", "new-secret", "new-secret");
        await submitForm();
        expect(client.changePassword).toHaveBeenCalledWith("old-secret", "new-secret", false);
        expect($("[data-change-password] [role=status]")?.textContent).toBe("Password changed.");
    });

    it("keeps the sheet open on a wrong current password and clears only that field", async () => {
        const client = fakeClient(new JournalApiError("That password is incorrect.", 401, "bad_password"));
        await open(client);
        await fill("wrong-one", "new-secret", "new-secret");
        await submitForm();
        expect($(".mj_ChangePasswordSheet [role=alert]")?.textContent).toBe("That password is incorrect.");
        expect($<HTMLInputElement>("#mj-change-password-current")!.value).toBe("");
        expect($<HTMLInputElement>("#mj-change-password-new")!.value).toBe("new-secret");
        expect(submitButton().disabled).toBe(true);
    });

    it("says how long a lockout lasts", async () => {
        await open(fakeClient(new JournalApiError("x", 429, "locked_out", 900)));
        await fill("old-secret", "new-secret", "new-secret");
        await submitForm();
        expect($("[role=alert]")?.textContent).toBe("Too many attempts. Try again in 15 minutes.");
    });

    it("sits in the Security group, and stays there on a journal without two-factor", async () => {
        const client = {
            twoFactorStatus: jest.fn().mockRejectedValue(new JournalApiError("nope", 404, "not_found")),
            isAdmin: jest.fn().mockResolvedValue(false),
            accountEmail: jest.fn().mockRejectedValue(new JournalApiError("nope", 404, "not_found")),
            changePassword: jest.fn(),
        };
        await act(async () => root.render(<SecuritySettings client={client as unknown as MatronJournalClient} />));
        expect($("#mj-settings-security")).not.toBeNull();
        expect($("[data-change-password]")).not.toBeNull();
        expect($("[data-two-factor]")).toBeNull();
    });
});

describe("Settings → Devices after a password change", () => {
    it("re-reads the roster when Settings bumps its revision", async () => {
        const client = { listDevices: jest.fn().mockResolvedValue([]) };
        const session = { serverUrl: "https://chat.example.com", token: "token", deviceId: 1 } as Session;
        const render = (revision: number) =>
            act(async () =>
                root.render(
                    <DevicesSettings
                        client={client as unknown as MatronJournalClient}
                        session={session}
                        revision={revision}
                    />,
                ),
            );
        await render(0);
        expect(client.listDevices).toHaveBeenCalledTimes(1);
        await render(1);
        expect(client.listDevices).toHaveBeenCalledTimes(2);
    });
});

describe("MatronJournalClient changePassword", () => {
    function signedInClient(): MatronJournalClient {
        const client = new MatronJournalClient();
        const internals = client as unknown as { state: ClientState; api: JournalApi };
        internals.state = { ...client.getSnapshot(), phase: "signed-in" };
        internals.api = new JournalApi("https://chat.example.com", "token");
        localStorage.setItem("matron_journal_session_v1", JSON.stringify({ token: "token" }));
        return client;
    }

    function answer(status: number, body: object): unknown {
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        return { status, headers: new Headers(), arrayBuffer: async () => bytes.buffer };
    }

    it("throws a wrong current password back without signing this device out", async () => {
        const client = signedInClient();
        const logout = jest.spyOn(client, "logout");
        const fetchMock = jest.fn().mockResolvedValue(answer(401, { error: "bad_password" }));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });

        await expect(client.changePassword("wrong-one", "new-secret", true)).rejects.toMatchObject({
            status: 401,
            code: "bad_password",
            message: "That password is incorrect.",
        });
        expect(logout).not.toHaveBeenCalled();
        expect(client.getSnapshot().phase).toBe("signed-in");
        expect(localStorage.getItem("matron_journal_session_v1")).not.toBeNull();
    });

    it("returns how many other devices were signed out", async () => {
        const client = signedInClient();
        const fetchMock = jest.fn().mockResolvedValue(answer(200, { ok: true, signed_out: 1 }));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
        await expect(client.changePassword("old-secret", "new-secret", true)).resolves.toEqual({ signed_out: 1 });
    });
});
