/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApiError } from "../api";
import { MatronJournalClient, type TwoFactorChallenge } from "../client";
import { MatronApp } from "../components";
import { groupedSecret, SecuritySettings } from "../TwoFactor";
import type { ClientState, MatronConfig, TwoFactorSetup, TwoFactorStatus } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SETUP: TwoFactorSetup = {
    secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    otpauth_uri:
        "otpauth://totp/Matron%3Aalice%40chat.example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Matron",
    issuer: "Matron",
    account: "alice@chat.example.com",
};
const CODES = Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-cccc-dd${String.fromCharCode(97 + i)}${(i % 8) + 2}`);
const CHALLENGE: TwoFactorChallenge = {
    kind: "code",
    serverUrl: "https://chat.example.com",
    username: "alice",
    ticket: "t".repeat(64),
};

function signedOutClient(
    config: MatronConfig = { journal_server_url: "https://chat.example.com" },
): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = { ...client.getSnapshot(), phase: "signed-out", config };
    return client;
}

function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

const click = async (element: Element | null): Promise<void> => {
    expect(element).not.toBeNull();
    await act(async () => (element as HTMLElement).click());
};

const submitForm = async (form: Element | null): Promise<void> => {
    expect(form).not.toBeNull();
    await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
};

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
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

/** A fetch answer, as jsdom has no Response. */
function answer(status: number, body: object): unknown {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return { status, headers: new Headers(), arrayBuffer: async () => bytes.buffer };
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);

describe("two-factor sign-in", () => {
    async function signIn(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_username")!, "alice"));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_password")!, "hunter22"));
        await submitForm($("form.mj_LoginForm"));
    }

    it("asks for a code after a right password, then finishes signing in", async () => {
        const client = signedOutClient();
        jest.spyOn(client, "login").mockResolvedValue(CHALLENGE);
        const finish = jest.fn().mockResolvedValue(undefined);
        const withCode = jest
            .spyOn(client, "loginWithCode")
            .mockResolvedValue({ usedRecoveryCode: false, recoveryCodesLeft: 10, finish });
        await signIn(client);

        expect($("[data-two-factor-step=code]")).not.toBeNull();
        expect($("#mj_LoginForm_password")).toBeNull();
        const field = $<HTMLInputElement>("#mj_LoginForm_code")!;
        expect(field.autocomplete).toBe("one-time-code");
        await act(async () => type(field, "123 456"));
        await submitForm($("[data-two-factor-step=code]"));
        expect(withCode).toHaveBeenCalledWith(CHALLENGE, "123 456");
        expect(finish).toHaveBeenCalled();
    });

    it("keeps the code step on a wrong code, and goes back to the password once the ticket is spent", async () => {
        const client = signedOutClient();
        jest.spyOn(client, "login").mockResolvedValue(CHALLENGE);
        const withCode = jest
            .spyOn(client, "loginWithCode")
            .mockRejectedValueOnce(
                new JournalApiError("That code didn't work.", 403, "bad_code", undefined, { ticket_valid: true }),
            )
            .mockRejectedValueOnce(
                new JournalApiError("That code didn't work.", 403, "bad_code", undefined, { ticket_valid: false }),
            );
        await signIn(client);

        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_code")!, "111111"));
        await submitForm($("[data-two-factor-step=code]"));
        expect($("[role=alert]")?.textContent).toBe("That code didn't work.");
        expect($("[data-two-factor-step=code]")).not.toBeNull();

        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_code")!, "222222"));
        await submitForm($("[data-two-factor-step=code]"));
        expect(withCode).toHaveBeenCalledTimes(2);
        expect($("[data-two-factor-step=code]")).toBeNull();
        expect($("#mj_LoginForm_password")).not.toBeNull();
        expect($("[role=alert]")?.textContent).toBe("Too many wrong codes. Enter your password again.");
    });

    it("says how many recovery codes are left after signing in with one", async () => {
        const client = signedOutClient();
        jest.spyOn(client, "login").mockResolvedValue(CHALLENGE);
        const finish = jest.fn().mockResolvedValue(undefined);
        jest.spyOn(client, "loginWithCode").mockResolvedValue({ usedRecoveryCode: true, recoveryCodesLeft: 2, finish });
        await signIn(client);
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_code")!, "abcd-efgh-ijkl-mnop"));
        await submitForm($("[data-two-factor-step=code]"));
        expect($("[data-two-factor-step=recovery-used]")?.textContent).toContain("2 codes left");
        expect(finish).not.toHaveBeenCalled();
        await click($("[data-two-factor-step=recovery-used] button"));
        expect(finish).toHaveBeenCalled();
    });

    it("walks an unenrolled user through setup when the server requires it", async () => {
        const client = signedOutClient();
        const enrol = { ...CHALLENGE, kind: "enrol" as const };
        jest.spyOn(client, "login").mockResolvedValue(enrol);
        jest.spyOn(client, "loginTwoFactorSetup").mockResolvedValue(SETUP);
        const finish = jest.fn().mockResolvedValue(undefined);
        const enable = jest.spyOn(client, "loginTwoFactorEnable").mockResolvedValue({ recoveryCodes: CODES, finish });
        await signIn(client);

        expect($("[data-two-factor-step=enrol]")).not.toBeNull();
        expect($("[data-two-factor-secret]")?.textContent).toBe(groupedSecret(SETUP.secret));
        expect($<HTMLAnchorElement>("[data-action=open-authenticator]")?.getAttribute("href")).toBe(SETUP.otpauth_uri);
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_code")!, "654321"));
        await submitForm($("[data-two-factor-step=enrol]"));
        expect(enable).toHaveBeenCalledWith(enrol, "654321");

        expect($("[data-recovery-codes]")?.querySelectorAll("li")).toHaveLength(10);
        const done = $<HTMLButtonElement>(".mj_RecoveryCodes_done")!;
        expect(done.disabled).toBe(true);
        await click($("[data-recovery-saved]"));
        expect(done.disabled).toBe(false);
        await click(done);
        expect(finish).toHaveBeenCalled();
    });
});

describe("MatronJournalClient two-factor login", () => {
    it("turns /login's two_factor_required into a challenge without storing a session", async () => {
        const client = signedOutClient();
        const fetchMock = jest
            .fn()
            .mockResolvedValue(
                answer(401, { error: "two_factor_required", two_factor_ticket: "abc", expires_in: 300 }),
            );
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
        const challenge = await client.login("https://chat.example.com", " alice ", "hunter22");
        expect(challenge).toEqual({
            kind: "code",
            serverUrl: "https://chat.example.com",
            username: "alice",
            ticket: "abc",
        });
        expect(localStorage.getItem("matron_journal_session_v1")).toBeNull();
    });

    it("still throws a plain wrong password", async () => {
        const client = signedOutClient();
        const fetchMock = jest.fn().mockResolvedValue(answer(403, { error: "bad_credentials" }));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
        await expect(client.login("https://chat.example.com", "alice", "nope")).rejects.toThrow(
            "The username or password is incorrect.",
        );
    });
});

describe("Settings → Security", () => {
    const OFF: TwoFactorStatus = {
        enabled: false,
        enabled_at: null,
        recovery_codes_left: 0,
        required: false,
        available: true,
    };
    const ON: TwoFactorStatus = {
        enabled: true,
        enabled_at: Date.UTC(2026, 0, 5),
        recovery_codes_left: 10,
        required: false,
        available: true,
    };

    function fakeClient(status: TwoFactorStatus | Error, admin = false) {
        return {
            twoFactorStatus: jest.fn(() =>
                status instanceof Error ? Promise.reject(status) : Promise.resolve(status),
            ),
            isAdmin: jest.fn().mockResolvedValue(admin),
            accountEmail: jest.fn().mockRejectedValue(new JournalApiError("nope", 404, "not_found")),
            twoFactorSetup: jest.fn().mockResolvedValue(SETUP),
            twoFactorEnable: jest.fn().mockResolvedValue({ recovery_codes: CODES, signed_out: 2 }),
            twoFactorDisable: jest.fn().mockResolvedValue(undefined),
            twoFactorRecoveryCodes: jest.fn().mockResolvedValue({ recovery_codes: CODES }),
            twoFactorPolicy: jest.fn().mockResolvedValue({ required: true }),
        };
    }

    async function render(client: ReturnType<typeof fakeClient>): Promise<void> {
        await act(async () => root.render(<SecuritySettings client={client as unknown as MatronJournalClient} />));
    }

    it("sets two-factor up: password, scan, code, recovery codes", async () => {
        const client = fakeClient(OFF);
        await render(client);
        expect($("[data-two-factor=off]")?.textContent).toContain("Off");
        await click($("[data-action=two-factor-setup]"));

        await act(async () => type($<HTMLInputElement>("#mj-two-factor-password")!, "hunter22"));
        await submitForm($(".mj_TwoFactorSheet"));
        expect(client.twoFactorSetup).toHaveBeenCalledWith("hunter22", undefined);
        expect($("[data-two-factor-secret]")).not.toBeNull();

        await click($("[data-sign-out-others]"));
        await act(async () => type($<HTMLInputElement>("#mj-two-factor-code")!, "123456"));
        await submitForm($(".mj_TwoFactorSheet"));
        expect(client.twoFactorEnable).toHaveBeenCalledWith("123456", true);
        expect($(".mj_TwoFactorSheet [role=status]")?.textContent).toContain("Signed out 2 other devices.");
        expect($("[data-recovery-codes]")?.querySelectorAll("li")).toHaveLength(10);
    });

    it("shows the state when on, warns when recovery codes run low, and turns off with password and code", async () => {
        const client = fakeClient({ ...ON, recovery_codes_left: 1 });
        await render(client);
        expect($("[data-two-factor=on]")?.textContent).toContain("1 recovery code left");
        expect($("[data-two-factor-low]")).not.toBeNull();

        await click($("[data-action=two-factor-disable]"));
        expect($(".mj_TwoFactorSheet")?.closest("[role=alertdialog]")).not.toBeNull();
        await act(async () => type($<HTMLInputElement>("#mj-two-factor-confirm-password")!, "hunter22"));
        await act(async () => type($<HTMLInputElement>("#mj-two-factor-confirm-code")!, "123456"));
        await submitForm($(".mj_TwoFactorSheet"));
        expect(client.twoFactorDisable).toHaveBeenCalledWith("hunter22", "123456");
        expect($(".mj_TwoFactorSheet")).toBeNull();
    });

    it("moving to a new app asks for a code from the old one", async () => {
        const client = fakeClient(ON);
        await render(client);
        await click($("[data-action=two-factor-move]"));
        await act(async () => type($<HTMLInputElement>("#mj-two-factor-password")!, "hunter22"));
        const go = $<HTMLButtonElement>(".mj_TwoFactorSheet button[type=submit]")!;
        expect(go.disabled).toBe(true);
        await act(async () => type($<HTMLInputElement>("#mj-two-factor-old-code")!, "999999"));
        expect(go.disabled).toBe(false);
        await submitForm($(".mj_TwoFactorSheet"));
        expect(client.twoFactorSetup).toHaveBeenCalledWith("hunter22", "999999");
    });

    it("hides Turn Off when the server requires two-factor", async () => {
        const client = fakeClient({ ...ON, required: true });
        await render(client);
        expect($("[data-action=two-factor-disable]")).toBeNull();
        expect(container.textContent).toContain("requires two-factor sign-in for everyone");
    });

    it("lets an admin require it for everyone", async () => {
        const client = fakeClient(ON, true);
        await render(client);
        const toggle = $<HTMLButtonElement>("[data-setting=two-factor-required]")!;
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        await click(toggle);
        expect(client.twoFactorPolicy).toHaveBeenCalledWith(true);
    });

    it("says so on a server that cannot store secrets, and keeps only Password on a journal without /2fa", async () => {
        await render(fakeClient({ ...OFF, available: false }));
        expect(container.textContent).toContain("isn't set up for two-factor");
        expect($("[data-action=two-factor-setup]")).toBeNull();
        await render(fakeClient(new JournalApiError("nope", 404, "not_found")));
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(fakeClient(new JournalApiError("nope", 404, "not_found")));
        expect($("[data-two-factor]")).toBeNull();
        expect($("[data-change-password]")).not.toBeNull();
    });
});

describe("held sign-ins", () => {
    it("finishes once however often Continue is pressed", async () => {
        const client = signedOutClient();
        jest.spyOn(client, "login").mockResolvedValue(CHALLENGE);
        let release: (() => void) | undefined;
        const finish = jest.fn().mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
        jest.spyOn(client, "loginWithCode").mockResolvedValue({ usedRecoveryCode: true, recoveryCodesLeft: 4, finish });
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_username")!, "alice"));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_password")!, "hunter22"));
        await submitForm($("form.mj_LoginForm"));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_code")!, "abcd-efgh-ijkl-mnop"));
        await submitForm($("[data-two-factor-step=code]"));

        const button = $<HTMLButtonElement>("[data-two-factor-step=recovery-used] button")!;
        await click(button);
        await click(button);
        expect(finish).toHaveBeenCalledTimes(1);
        expect(button.disabled).toBe(true);
        await act(async () => release!());
    });
});
