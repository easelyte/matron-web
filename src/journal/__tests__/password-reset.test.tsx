/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApiError } from "../api";
import { MatronJournalClient } from "../client";
import { MatronApp } from "../components";
import {
    FORGOT_CHECK_DEBOUNCE_MS,
    PASSWORD_RESET_DONE,
    RESET_LINK_INVALID,
    RESET_LINK_SENT,
    resetFailure,
    resetTakenLinkForTests,
    takeResetLink,
} from "../PasswordReset";
import type { ClientState, MatronConfig, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

function signedOutClient(config: MatronConfig = { journal_server_url: "https://chat.example.com" }) {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = { ...client.getSnapshot(), phase: "signed-out", config };
    return client;
}

function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);

const click = async (element: Element | null): Promise<void> => {
    expect(element).not.toBeNull();
    await act(async () => (element as HTMLElement).click());
};

const submitForm = async (): Promise<void> => {
    await act(async () => {
        $("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
};

function answer(status: number, body: object): unknown {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return { status, headers: new Headers(), arrayBuffer: async () => bytes.buffer };
}

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });
    Object.defineProperty(globalThis, "TextDecoder", { value: NodeTextDecoder, configurable: true });
});

beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/app/");
    resetTakenLinkForTests();
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

const render = (client: MatronJournalClient) => act(async () => root.render(<MatronApp client={client} />));

/** Let the sign-in screen's debounced "can this server send mail?" ask go out and answer. */
async function settleForgotCheck(): Promise<void> {
    await act(async () => {
        jest.advanceTimersByTime(FORGOT_CHECK_DEBOUNCE_MS);
    });
    await act(async () => undefined);
}

describe("reset link", () => {
    it("reads the token from the address and strips it, once", () => {
        window.history.replaceState(null, "", "/app/reset-password?x=1#token=abc-123");
        expect(takeResetLink()).toEqual({ token: "abc-123" });
        expect(window.location.hash).toBe("");
        expect(window.location.pathname).toBe("/app/reset-password");
        expect(window.location.search).toBe("?x=1");
        expect(takeResetLink()).toEqual({ token: "abc-123" });
    });

    it("is nothing on any other page", () => {
        window.history.replaceState(null, "", "/app/#token=abc");
        expect(takeResetLink()).toBeNull();
        expect(window.location.hash).toBe("#token=abc");
    });

    it("words a rate limit", () => {
        expect(resetFailure(new JournalApiError("x", 429, "rate_limited"))).toBe(
            "Too many requests. Try again in a few minutes.",
        );
    });
});

describe("sign-in screen: Forgot password?", () => {
    beforeEach(() => jest.useFakeTimers());

    it("shows the link only when the server says it can send mail", async () => {
        const client = signedOutClient();
        const enabled = jest.spyOn(client, "forgotPasswordEnabled").mockResolvedValue(false);
        await render(client);
        await settleForgotCheck();
        expect(enabled).toHaveBeenCalledWith("https://chat.example.com");
        expect($("[data-action=forgot-password]")).toBeNull();

        await act(async () => root.unmount());
        root = createRoot(container);
        enabled.mockResolvedValue(true);
        await render(client);
        expect($("[data-action=forgot-password]")).toBeNull();
        await settleForgotCheck();
        expect($("[data-action=forgot-password]")?.textContent).toBe("Forgot password?");
    });

    it("asks the server typed into the field, once typing stops", async () => {
        const client = signedOutClient({});
        const enabled = jest.spyOn(client, "forgotPasswordEnabled").mockResolvedValue(true);
        await render(client);
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_server")!, "chat.exa"));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_server")!, "chat.example.com"));
        await settleForgotCheck();
        expect(enabled).toHaveBeenCalledTimes(1);
        expect(enabled).toHaveBeenCalledWith("chat.example.com");
        expect($("[data-action=forgot-password]")).not.toBeNull();
        // A different server hides the link until it has answered too.
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_server")!, "other.example.com"));
        expect($("[data-action=forgot-password]")).toBeNull();
    });

    it("prefills the username, sends the ask, and always says the same thing", async () => {
        const client = signedOutClient();
        jest.spyOn(client, "forgotPasswordEnabled").mockResolvedValue(true);
        const forgot = jest.spyOn(client, "forgotPassword").mockResolvedValue(undefined);
        await render(client);
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_username")!, "alice"));
        await settleForgotCheck();
        await click($("[data-action=forgot-password]"));

        const field = $<HTMLInputElement>("#mj_LoginForm_identifier")!;
        expect(container.textContent).toContain("Username or email");
        expect(field.value).toBe("alice");
        await submitForm();
        expect(forgot).toHaveBeenCalledWith("https://chat.example.com", "alice");
        expect($("[data-forgot-step=sent] [role=status]")?.textContent).toBe(RESET_LINK_SENT);

        await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Back to sign in")!);
        expect($("#mj_LoginForm_password")).not.toBeNull();
    });

    it("says to wait when rate limited", async () => {
        const client = signedOutClient();
        jest.spyOn(client, "forgotPasswordEnabled").mockResolvedValue(true);
        jest.spyOn(client, "forgotPassword").mockRejectedValue(new JournalApiError("x", 429, "rate_limited"));
        await render(client);
        await settleForgotCheck();
        await click($("[data-action=forgot-password]"));
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_identifier")!, "alice@example.com"));
        await submitForm();
        expect($("[role=alert]")?.textContent).toBe("Too many requests. Try again in a few minutes.");
        expect($("[data-forgot-step=sent]")).toBeNull();
    });
});

describe("/app/reset-password", () => {
    const fill = async (next: string, confirm: string): Promise<void> => {
        await act(async () => type($<HTMLInputElement>("#mj_ResetPassword_new")!, next));
        await act(async () => type($<HTMLInputElement>("#mj_ResetPassword_confirm")!, confirm));
    };

    it("resets the password with the token, then offers Sign in", async () => {
        window.history.replaceState(null, "", "/app/reset-password#token=tok-1");
        const client = signedOutClient();
        const reset = jest.spyOn(client, "resetPassword").mockResolvedValue(undefined);
        await render(client);
        expect(window.location.hash).toBe("");
        expect($("h1")?.textContent).toBe("Reset your password");
        expect($<HTMLInputElement>("#mj_ResetPassword_new")!.autocomplete).toBe("new-password");
        const go = $<HTMLButtonElement>("button[type=submit]")!;
        expect(go.disabled).toBe(true);

        await fill("short", "short");
        await submitForm();
        expect($("[role=alert]")?.textContent).toBe("Use at least 8 characters.");
        await fill("new-secret", "new-secreT");
        await submitForm();
        expect($("[role=alert]")?.textContent).toBe("The new passwords don't match.");
        expect(reset).not.toHaveBeenCalled();

        await fill("new-secret", "new-secret");
        await submitForm();
        expect(reset).toHaveBeenCalledWith("https://chat.example.com", "tok-1", "new-secret");
        expect($("[role=status]")?.textContent).toBe(PASSWORD_RESET_DONE);
        await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Sign in")!);
        expect(window.location.pathname).toBe("/app/");
        expect($("#mj_LoginForm_password")).not.toBeNull();
    });

    it("says a spent link has expired and leads back to Forgot password?", async () => {
        window.history.replaceState(null, "", "/app/reset-password#token=old");
        const client = signedOutClient();
        jest.spyOn(client, "resetPassword").mockRejectedValue(new JournalApiError("x", 400, "invalid_token"));
        jest.spyOn(client, "forgotPasswordEnabled").mockResolvedValue(true);
        await render(client);
        await fill("new-secret", "new-secret");
        await submitForm();
        expect($("[data-reset-password=invalid] [role=alert]")?.textContent).toBe(RESET_LINK_INVALID);
        await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Forgot password?")!);
        expect($("#mj_LoginForm_identifier")).not.toBeNull();
    });

    it("asks for a new link from the journal the link came from, not the last one used", async () => {
        localStorage.setItem("matron_journal_last_server", "https://other.example.com");
        window.history.replaceState(null, "", "/app/reset-password#token=old");
        const client = signedOutClient({});
        jest.spyOn(client, "resetPassword").mockRejectedValue(new JournalApiError("x", 400, "invalid_token"));
        jest.spyOn(client, "forgotPasswordEnabled").mockResolvedValue(true);
        const forgot = jest.spyOn(client, "forgotPassword").mockResolvedValue(undefined);
        await render(client);
        await fill("new-secret", "new-secret");
        await submitForm();
        await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Forgot password?")!);
        await act(async () => type($<HTMLInputElement>("#mj_LoginForm_identifier")!, "alice"));
        await submitForm();
        expect(forgot).toHaveBeenCalledWith(window.location.origin, "alice");
        await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Back to sign in")!);
        expect($<HTMLInputElement>("#mj_LoginForm_server")!.value).toBe(window.location.origin);
    });

    it("says so at once when the link has no token", async () => {
        window.history.replaceState(null, "", "/app/reset-password");
        await render(signedOutClient());
        expect($("[data-reset-password=invalid]")?.textContent).toContain(RESET_LINK_INVALID);
    });

    it("works on the journal's own origin when config names no server", async () => {
        window.history.replaceState(null, "", "/app/reset-password#token=tok-2");
        const client = signedOutClient({});
        const reset = jest.spyOn(client, "resetPassword").mockResolvedValue(undefined);
        await render(client);
        await fill("new-secret", "new-secret");
        await submitForm();
        expect(reset).toHaveBeenCalledWith(window.location.origin, "tok-2", "new-secret");
    });
});

describe("MatronJournalClient.forgotPasswordEnabled", () => {
    it("rejects, rather than throws, for a server address that can't be used", async () => {
        const client = new MatronJournalClient();
        let pending: Promise<boolean> | undefined;
        expect(() => {
            pending = client.forgotPasswordEnabled("https://");
        }).not.toThrow();
        await expect(pending).rejects.toThrow();
    });
});

describe("MatronJournalClient.resetPassword", () => {
    function signedInTo(serverUrl: string): MatronJournalClient {
        const client = new MatronJournalClient();
        const session: Session = { serverUrl, token: "token", deviceId: 1, userId: 1, username: "alice" };
        (client as unknown as { state: ClientState }).state = { ...client.getSnapshot(), phase: "signed-in", session };
        return client;
    }

    it("signs this browser out when it was signed in to the same journal", async () => {
        const client = signedInTo("https://chat.example.com");
        const logout = jest.spyOn(client, "logout").mockResolvedValue(undefined);
        const fetchMock = jest.fn().mockResolvedValue(answer(200, { ok: true, signed_out: 2 }));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
        await client.resetPassword("https://chat.example.com", "tok", "new-secret");
        expect(logout).toHaveBeenCalled();
    });

    it("leaves a session on another journal alone", async () => {
        const client = signedInTo("https://other.example.com");
        const logout = jest.spyOn(client, "logout").mockResolvedValue(undefined);
        const fetchMock = jest.fn().mockResolvedValue(answer(200, { ok: true, signed_out: 2 }));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
        await client.resetPassword("https://chat.example.com", "tok", "new-secret");
        expect(logout).not.toHaveBeenCalled();
    });

    it("signs nothing out when the link was refused", async () => {
        const client = signedInTo("https://chat.example.com");
        const logout = jest.spyOn(client, "logout").mockResolvedValue(undefined);
        const fetchMock = jest.fn().mockResolvedValue(answer(400, { error: "invalid_token" }));
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
        await expect(client.resetPassword("https://chat.example.com", "tok", "new-secret")).rejects.toMatchObject({
            code: "invalid_token",
        });
        expect(logout).not.toHaveBeenCalled();
    });
});
