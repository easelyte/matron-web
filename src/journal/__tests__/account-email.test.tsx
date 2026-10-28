/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";

import { AccountEmailRow, emailFailure, looksLikeEmail, UsersSettings } from "../AccountEmail";
import { JournalApi, JournalApiError } from "../api";
import { MatronJournalClient } from "../client";
import type { AccountEmail, ClientState, JournalUser } from "../types";

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

const submitSheet = async (): Promise<void> => {
    await act(async () => {
        $(".mj_AccountEmailSheet")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
};

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

describe("account email: wording", () => {
    it("words each refusal", () => {
        expect(emailFailure(new JournalApiError("x", 401, "bad_password"))).toBe("That password is incorrect.");
        expect(emailFailure(new JournalApiError("x", 400, "bad_email"))).toBe("Enter a valid email address.");
        expect(emailFailure(new JournalApiError("x", 409, "email_taken"))).toBe(
            "Another account already uses that address.",
        );
        expect(emailFailure(new JournalApiError("x", 429, "locked_out", 120))).toBe(
            "Too many attempts. Try again in 2 minutes.",
        );
    });

    it("checks the shape of an address", () => {
        expect(looksLikeEmail("alice@example.com")).toBe(true);
        expect(looksLikeEmail(" alice@example.com ")).toBe(true);
        expect(looksLikeEmail("alice")).toBe(false);
        expect(looksLikeEmail("alice@example")).toBe(false);
    });
});

describe("Settings → Security → Email address", () => {
    function fakeClient(account: AccountEmail | Error, save: () => Promise<{ email: string | null }> = jest.fn()) {
        return {
            accountEmail: jest.fn(() =>
                account instanceof Error ? Promise.reject(account) : Promise.resolve(account),
            ),
            setAccountEmail: jest.fn(save),
        };
    }

    const render = (client: ReturnType<typeof fakeClient>) =>
        act(async () => root.render(<AccountEmailRow client={client as unknown as MatronJournalClient} />));

    it("shows Not set with the reset help, and that the journal can't send mail yet", async () => {
        await render(fakeClient({ email: null, reset_by_email: false }));
        const row = $("[data-account-email=unset]")!;
        expect(row.textContent).toContain("Email address");
        expect(row.textContent).toContain("Not set");
        expect(row.textContent).toContain("Used to reset your password if you forget it.");
        expect(row.textContent).toContain("This journal can't send email yet.");
        expect($("[data-action=account-email]")?.textContent).toBe("Add…");
    });

    it("shows the address, without the warning when mail works", async () => {
        await render(fakeClient({ email: "alice@example.com", reset_by_email: true }));
        const row = $("[data-account-email=set]")!;
        expect(row.textContent).toContain("alice@example.com");
        expect(row.textContent).not.toContain("can't send email");
        expect($("[data-action=account-email]")?.textContent).toBe("Change…");
    });

    it("hides itself on a journal without /account/email", async () => {
        await render(fakeClient(new JournalApiError("nope", 404, "not_found")));
        expect($("[data-account-email]")).toBeNull();
    });

    it("saves a new address with the current password", async () => {
        const client = fakeClient({ email: null, reset_by_email: true }, async () => ({ email: "alice@example.com" }));
        await render(client);
        await click($("[data-action=account-email]"));
        expect($<HTMLInputElement>("#mj-account-email")!.type).toBe("email");
        expect($<HTMLInputElement>("#mj-account-email-password")!.autocomplete).toBe("current-password");
        expect($("[data-action=remove-email]")).toBeNull();
        const save = $<HTMLButtonElement>(".mj_AccountEmailSheet button[type=submit]")!;
        await act(async () => type($<HTMLInputElement>("#mj-account-email")!, "alice@example.com"));
        expect(save.disabled).toBe(true);
        await act(async () => type($<HTMLInputElement>("#mj-account-email-password")!, "secret-1"));
        expect(save.disabled).toBe(false);
        await submitSheet();
        expect(client.setAccountEmail).toHaveBeenCalledWith("secret-1", "alice@example.com");
        expect($(".mj_AccountEmailSheet")).toBeNull();
        expect($("[data-account-email=set]")?.textContent).toContain("alice@example.com");
    });

    it("checks the address before sending", async () => {
        const client = fakeClient({ email: null, reset_by_email: true });
        await render(client);
        await click($("[data-action=account-email]"));
        await act(async () => type($<HTMLInputElement>("#mj-account-email")!, "alice"));
        await act(async () => type($<HTMLInputElement>("#mj-account-email-password")!, "secret-1"));
        await submitSheet();
        expect($("[role=alert]")?.textContent).toBe("Enter a valid email address.");
        expect(client.setAccountEmail).not.toHaveBeenCalled();
    });

    it("keeps the sheet open on a wrong password and clears it", async () => {
        const client = fakeClient({ email: "alice@example.com", reset_by_email: true }, () =>
            Promise.reject(new JournalApiError("x", 401, "bad_password")),
        );
        await render(client);
        await click($("[data-action=account-email]"));
        await act(async () => type($<HTMLInputElement>("#mj-account-email")!, "alice@example.org"));
        await act(async () => type($<HTMLInputElement>("#mj-account-email-password")!, "wrong-one"));
        await submitSheet();
        expect($(".mj_AccountEmailSheet [role=alert]")?.textContent).toBe("That password is incorrect.");
        expect($<HTMLInputElement>("#mj-account-email-password")!.value).toBe("");
        expect($<HTMLInputElement>("#mj-account-email")!.value).toBe("alice@example.org");
    });

    it("removes the address with the current password", async () => {
        const client = fakeClient({ email: "alice@example.com", reset_by_email: true }, async () => ({ email: null }));
        await render(client);
        await click($("[data-action=account-email]"));
        const remove = $<HTMLButtonElement>("[data-action=remove-email]")!;
        expect(remove.disabled).toBe(true);
        await act(async () => type($<HTMLInputElement>("#mj-account-email-password")!, "secret-1"));
        await click(remove);
        expect(client.setAccountEmail).toHaveBeenCalledWith("secret-1", null);
        expect($("[data-account-email=unset]")?.textContent).toContain("Not set");
    });
});

describe("MatronJournalClient.setAccountEmail", () => {
    it("throws a wrong password back without signing this device out", async () => {
        const client = new MatronJournalClient();
        const internals = client as unknown as { state: ClientState; api: JournalApi };
        internals.state = { ...client.getSnapshot(), phase: "signed-in" };
        internals.api = new JournalApi("https://chat.example.com", "token");
        const logout = jest.spyOn(client, "logout");
        const bytes = new TextEncoder().encode(JSON.stringify({ error: "bad_password" }));
        const fetchMock = jest
            .fn()
            .mockResolvedValue({ status: 401, headers: new Headers(), arrayBuffer: async () => bytes.buffer });
        Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });

        await expect(client.setAccountEmail("wrong-one", " alice@example.com ")).rejects.toMatchObject({
            status: 401,
            code: "bad_password",
        });
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
            password: "wrong-one",
            email: "alice@example.com",
        });
        expect(logout).not.toHaveBeenCalled();
        expect(client.getSnapshot().phase).toBe("signed-in");
    });
});

describe("Settings → Users (admins)", () => {
    const USERS: JournalUser[] = [
        { id: 2, name: "bob", email: null, is_admin: false },
        { id: 1, name: "alice", email: "alice@example.com", is_admin: true },
    ];

    function fakeClient(admin: boolean) {
        let users = USERS;
        return {
            isAdmin: jest.fn().mockResolvedValue(admin),
            listUsers: jest.fn(async () => users),
            setUserEmail: jest.fn(async (id: number, email: string | null) => {
                users = users.map((user) => (user.id === id ? { ...user, email } : user));
                return users.find((user) => user.id === id);
            }),
        };
    }

    const render = (client: ReturnType<typeof fakeClient>) =>
        act(async () => root.render(<UsersSettings client={client as unknown as MatronJournalClient} />));

    it("is hidden from anyone but an admin", async () => {
        const client = fakeClient(false);
        await render(client);
        expect($("#mj-settings-users")).toBeNull();
        expect(client.listUsers).not.toHaveBeenCalled();
    });

    it("lists every user with their address, sorted by name", async () => {
        await render(fakeClient(true));
        const rows = [...document.querySelectorAll("[data-user]")];
        expect(rows.map((row) => row.querySelector(".mj_DevicesList_name")?.textContent)).toEqual([
            "aliceAdmin",
            "bob",
        ]);
        expect(rows.map((row) => row.querySelector("[data-user-email]")?.textContent)).toEqual([
            "alice@example.com",
            "No email address",
        ]);
    });

    it("sets and clears an address without asking for a password", async () => {
        const client = fakeClient(true);
        await render(client);
        await click($("[data-user='2'] [data-user-action=email]"));
        expect($("#mj-account-email-password")).toBeNull();
        await act(async () => type($<HTMLInputElement>("#mj-account-email")!, "bob@example.com"));
        await submitSheet();
        expect(client.setUserEmail).toHaveBeenCalledWith(2, "bob@example.com");
        expect($("[data-user='2'] [data-user-email]")?.textContent).toBe("bob@example.com");

        await click($("[data-user='1'] [data-user-action=email]"));
        await click($("[data-action=remove-email]"));
        expect(client.setUserEmail).toHaveBeenCalledWith(1, null);
        expect($("[data-user='1'] [data-user-email]")?.textContent).toBe("No email address");
    });

    it("says why an address was refused", async () => {
        const client = fakeClient(true);
        client.setUserEmail.mockRejectedValue(new JournalApiError("x", 409, "email_taken"));
        await render(client);
        await click($("[data-user='2'] [data-user-action=email]"));
        await act(async () => type($<HTMLInputElement>("#mj-account-email")!, "alice@example.com"));
        await submitSheet();
        expect($(".mj_AccountEmailSheet [role=alert]")?.textContent).toBe("Another account already uses that address.");
    });
});
