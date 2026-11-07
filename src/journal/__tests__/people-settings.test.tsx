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
import type { Contact, ContactInvite, InviteOpened } from "../contacts";
import { PeopleCardView, parsePeopleCard } from "../people-card";
import { setTheme } from "../theme";
import type { ClientState, Conversation, JournalEvent, Session, TrackerItem } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://a.example",
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

const LINK = `matron://contact?v=1&j=b.example&u=bob&t=${"A".repeat(43)}&fp=gs462nr3vwew6cbb2cxzvrtide`;
const OWN_LINK = `matron://contact?v=1&j=a.example&u=carol&t=${"B".repeat(43)}&fp=pa5pus3ihkp6rxwrt5wxofen7e`;
const BOB: Contact = {
    id: "ct_1",
    address: "bob@b.example",
    peer_user: "bob",
    peer_journal: "b.example",
    display_name: "bob",
    state: "active",
    key_changed: false,
};
const OPEN_INVITE: ContactInvite = {
    id: "inv_1",
    state: "open",
    created_at: Date.UTC(2026, 10, 7),
    expires_at: Date.UTC(2026, 10, 14),
};
const OPENED: InviteOpened = {
    inviter: {
        address: "bob@b.example",
        name: "bob",
        journal: "b.example",
        fingerprint: "gs46 2nr3 vwew 6cbb 2cxz vrti de",
    },
    key_changed: false,
    contact: null,
};

function signedInClient() {
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
    let invites: ContactInvite[] = [{ ...OPEN_INVITE }, { ...OPEN_INVITE, id: "inv_used", state: "used" }];
    const api = {
        devices: jest.fn(() => Promise.resolve({ devices: [] })),
        defaults: jest.fn(() => new Promise(() => undefined)),
        twoFactorStatus: jest.fn().mockRejectedValue(new JournalApiError("Not found", 404, "not_found")),
        accountEmail: jest.fn().mockRejectedValue(new JournalApiError("Not found", 404, "not_found")),
        contacts: jest.fn(async () => [
            BOB,
            { ...BOB, id: "ct_2", address: "dave@c.example", display_name: "dave", key_changed: true },
        ]),
        contactInvites: jest.fn(async () => invites),
        createContactInvite: jest.fn(async () => {
            const invite = { ...OPEN_INVITE, id: "inv_new" };
            invites = [invite, ...invites];
            return { invite, link: LINK };
        }),
        withdrawContactInvite: jest.fn(async (id: string) => {
            invites = invites.map((invite) => (invite.id === id ? { ...invite, state: "revoked" as const } : invite));
            return invites.find((invite) => invite.id === id)!;
        }),
        openContactInvite: jest.fn(async (link: string) => {
            if (link === OWN_LINK) {
                throw new JournalApiError("refused", 409, "conflict", undefined, {
                    error: "conflict",
                    blocked_by: "own_journal",
                });
            }
            return OPENED;
        }),
        acceptContactInvite: jest.fn(async () => ({ ...BOB, state: "pending_out" })),
        answerInviteAsk: jest.fn(async () => ({ ask: { id: "ask_1", state: "approved" }, link: LINK })),
    };
    (client as unknown as { api: typeof api }).api = api;
    return { client, api };
}

describe("People", () => {
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
        jest.restoreAllMocks();
    });

    async function openSettings(client: MatronJournalClient): Promise<void> {
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
    }

    const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(".mj_DeviceSheet");
    const click = async (selector: string, scope: ParentNode = document): Promise<void> => {
        await act(async () => scope.querySelector<HTMLButtonElement>(selector)!.click());
    };
    const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement =>
        [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;

    it("lists contacts with their full address and a changed key", async () => {
        const { client } = signedInClient();
        await openSettings(client);
        const bob = document.querySelector<HTMLElement>('[data-contact="bob@b.example"]')!;
        expect(bob.textContent).toContain("bob@b.example");
        const dave = document.querySelector<HTMLElement>('[data-contact="dave@c.example"]')!;
        expect(dave.textContent).toContain("Their journal's key has changed");
    });

    it("makes an invite and shows its link once, then lists it under Open invites", async () => {
        const { client, api } = signedInClient();
        await openSettings(client);
        // Only open invites are listed.
        expect(document.querySelectorAll("[data-invite]")).toHaveLength(1);
        await click('[data-action="invite-remote"]');
        expect(api.createContactInvite).toHaveBeenCalledTimes(1);
        expect(sheet()!.querySelector("[data-invite-link]")!.textContent).toBe(LINK);
        expect(sheet()!.querySelector('svg[aria-label="Invite QR code"]')).not.toBeNull();
        expect(sheet()!.textContent).toContain("It is shown only now, works once and lasts 7 days.");
        await act(async () => buttonIn(sheet()!, "Done").click());
        expect(sheet()).toBeNull();
        expect(document.querySelectorAll("[data-invite]")).toHaveLength(2);
        expect(document.body.textContent).not.toContain(LINK);
    });

    it("withdraws an open invite", async () => {
        const { client, api } = signedInClient();
        await openSettings(client);
        await click('[data-invite="inv_1"] [data-action="withdraw-invite"]');
        expect(api.withdrawContactInvite).toHaveBeenCalledWith("inv_1");
        expect(document.querySelectorAll("[data-invite]")).toHaveLength(0);
    });

    it("opens a pasted link, shows who sent it, and accepts", async () => {
        const { client, api } = signedInClient();
        await openSettings(client);
        await click('[data-action="paste-invite"]');
        const input = sheet()!.querySelector<HTMLInputElement>("input")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, LINK);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => buttonIn(sheet()!, "Open").click());
        const card = document.querySelector<HTMLElement>(".mj_AcceptInvite")!;
        expect(api.openContactInvite).toHaveBeenCalledWith(LINK);
        expect(card.querySelector('[data-field="address"]')!.textContent).toBe("bob@b.example");
        expect(card.querySelector('[data-field="journal"]')!.textContent).toBe("b.example");
        expect(card.querySelector('[data-field="fingerprint"]')!.textContent).toBe("gs46 2nr3 vwew 6cbb 2cxz vrti de");
        expect(card.textContent).toContain("Compare this fingerprint with them another way");
        expect(api.acceptContactInvite).not.toHaveBeenCalled();
        await click('[data-action="accept-invite"]', card);
        expect(api.acceptContactInvite).toHaveBeenCalledWith(LINK);
        expect(card.textContent).toContain("Sent. You become contacts when their journal confirms.");
    });

    it("offers no Accept to someone who is already a contact", async () => {
        const { client, api } = signedInClient();
        api.openContactInvite.mockResolvedValueOnce({ ...OPENED, contact: BOB });
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => client.openContactInvite(LINK));
        const card = document.querySelector<HTMLElement>(".mj_AcceptInvite")!;
        expect(card.textContent).toContain("You are already contacts.");
        expect(card.querySelector('[data-action="accept-invite"]')).toBeNull();
    });

    it("sends nothing on Cancel", async () => {
        const { client, api } = signedInClient();
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => client.openContactInvite(LINK));
        await act(async () => buttonIn(document.querySelector(".mj_AcceptInvite")!, "Cancel").click());
        expect(document.querySelector(".mj_AcceptInvite")).toBeNull();
        expect(api.acceptContactInvite).not.toHaveBeenCalled();
    });

    it("says why a link is refused, in plain words", async () => {
        const { client } = signedInClient();
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () => client.openContactInvite(OWN_LINK));
        const card = document.querySelector<HTMLElement>(".mj_AcceptInvite")!;
        expect(card.querySelector("[data-refusal]")!.textContent).toBe(
            "This link is from your own journal. Add people here by name instead.",
        );
        expect(card.querySelector('[data-action="accept-invite"]')).toBeNull();
    });

    it("shows the link an Approve tap on the ask's item returns, once", async () => {
        const { client } = signedInClient();
        await act(async () => root.render(<MatronApp client={client} />));
        await act(async () =>
            (client as unknown as { patch(u: Partial<ClientState>): void }).patch({ mintedInviteLink: LINK }),
        );
        expect(sheet()!.querySelector("[data-invite-link]")!.textContent).toBe(LINK);
        await act(async () => buttonIn(sheet()!, "Done").click());
        expect(client.getSnapshot().mintedInviteLink).toBeUndefined();
    });
});

describe("The invite ask card", () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const event: JournalEvent = {
        convo_id: "c1",
        seq: 5,
        ts: Date.UTC(2026, 10, 7, 12),
        type: "permission_request",
        sender: "agent:alice-box",
        payload: { kind: "contact_invite", direction: "out", ask_id: "ask_1", from_name: "alice-box" },
    } as JournalEvent;

    it("approves on the card and shows the minted link once", async () => {
        const card = parsePeopleCard(event.payload)!;
        expect(card.label).toBe("Invite link request");
        expect(card.consentUrl).toBe("matron://consent/invite/ask_1");
        const answer = jest.fn(async () => ({ ask: { id: "ask_1", state: "approved" as const }, link: LINK }));
        await act(async () =>
            root.render(
                <PeopleCardView
                    event={event}
                    card={card}
                    findItem={async () => null}
                    onOpenItem={() => undefined}
                    answerInviteAsk={answer}
                />,
            ),
        );
        await act(async () =>
            container.querySelector<HTMLButtonElement>('[data-action="approve-invite-ask"]')!.click(),
        );
        expect(answer).toHaveBeenCalledWith("ask_1", "approve");
        expect(container.querySelector("[data-invite-link]")!.textContent).toBe(LINK);
        expect(container.textContent).toContain("Shown only on this device, this once.");
    });

    it("keeps the buttons when the journal cannot mint yet", async () => {
        const card = parsePeopleCard(event.payload)!;
        const answer = jest.fn(async () => {
            throw new JournalApiError("refused", 409, "conflict", undefined, {
                error: "conflict",
                blocked_by: "too_many_invites",
            });
        });
        await act(async () =>
            root.render(
                <PeopleCardView
                    event={event}
                    card={card}
                    findItem={async () => null}
                    onOpenItem={() => undefined}
                    answerInviteAsk={answer}
                />,
            ),
        );
        await act(async () =>
            container.querySelector<HTMLButtonElement>('[data-action="approve-invite-ask"]')!.click(),
        );
        expect(container.textContent).toContain("You already have 20 open invites.");
        expect(container.querySelector('[data-action="approve-invite-ask"]')).not.toBeNull();
    });

    it("offers no buttons once the ask's item is closed", async () => {
        const card = parsePeopleCard(event.payload)!;
        const answer = jest.fn();
        await act(async () =>
            root.render(
                <PeopleCardView
                    event={event}
                    card={card}
                    findItem={async () => null}
                    onOpenItem={() => undefined}
                    answerInviteAsk={answer}
                    loadConsentItem={async () => ({ num: 9, state: "closed", resolution: "decided" }) as TrackerItem}
                />,
            ),
        );
        expect(container.querySelector('[data-action="approve-invite-ask"]')).toBeNull();
        expect(container.textContent).toContain("Already answered.");
        expect(answer).not.toHaveBeenCalled();
    });

    it("says so when the ask was already answered elsewhere", async () => {
        const card = parsePeopleCard(event.payload)!;
        const answer = jest.fn(async () => {
            throw new JournalApiError("refused", 409, "conflict", undefined, {
                error: "conflict",
                blocked_by: "not_pending",
            });
        });
        await act(async () =>
            root.render(
                <PeopleCardView
                    event={event}
                    card={card}
                    findItem={async () => null}
                    onOpenItem={() => undefined}
                    answerInviteAsk={answer}
                />,
            ),
        );
        await act(async () =>
            container.querySelector<HTMLButtonElement>('[data-action="approve-invite-ask"]')!.click(),
        );
        expect(container.textContent).toContain("Already answered.");
        expect(container.querySelector('[data-action="approve-invite-ask"]')).toBeNull();
    });
});
