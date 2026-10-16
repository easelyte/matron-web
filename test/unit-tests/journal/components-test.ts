/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { resetShowTheWorkForTests, SHOW_THE_WORK_KEY } from "../../../src/journal/show-the-work";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JournalApiError } from "../../../src/journal/api";
import {
    archiveStore,
    BROWSER_MEMORY_SAFETY_MAX_BYTES,
    favoriteStore,
    MatronJournalClient,
    pinnedStore,
    PREFERENCES_UNAVAILABLE_ERROR,
    unreadStore,
} from "../../../src/journal/client";
import { makeDraftStore } from "../../../src/journal/composer-drafts";
import {
    EventContent,
    isPermissionDecisionReply,
    isQueuedReleaseReply,
    MatronApp,
} from "../../../src/journal/components";
import { makeRecentFoldersStore } from "../../../src/journal/slash-palette";
import type {
    ClientState,
    Conversation,
    JournalEvent,
    PendingMessage,
    Session,
    TrackerItem,
} from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder, configurable: true });

const CONVERSATION = {
    id: "c1",
    title: "One",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "t",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

interface ClientInternals {
    state: ClientState;
    database?: unknown;
    pendingFiles: Map<string, File>;
    patch(update: Partial<ClientState>): void;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(
    options: {
        pendingMessages?: PendingMessage[];
        events?: JournalEvent[];
    } = {},
): MatronJournalClient {
    const client = new MatronJournalClient();
    internals(client).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [CONVERSATION],
        selectedConversationId: CONVERSATION.id,
        events: options.events ?? [],
        pendingMessages: options.pendingMessages ?? [],
        connection: "online",
        archivedIds: archiveStore.read(SESSION).ids,
        pinnedIds: pinnedStore.read(SESSION).ids,
        favoriteIds: favoriteStore.read(SESSION).ids,
        unreadOverrideIds: unreadStore.read(SESSION).ids,
    };
    return client;
}

function signedInWithRooms(conversations: Conversation[]): MatronJournalClient {
    const client = signedInClient();
    internals(client).state = {
        ...client.getSnapshot(),
        conversations,
    };
    return client;
}

async function renderClient(client: MatronJournalClient): Promise<{
    container: HTMLDivElement;
    root: Root;
}> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(React.createElement(MatronApp, { client }));
    });
    return { container, root };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
}

function menuItem(container: HTMLElement, text: string): Element | undefined {
    return [...container.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.includes(text));
}

function tabButton(container: HTMLElement, key: "active" | "favorites" | "archived"): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`)!;
}

async function openMenu(container: HTMLElement): Promise<void> {
    // The kebab was removed; the row menu opens via right-click (onContextMenu).
    const row = container.querySelector<HTMLElement>(".mj_ConversationListItem");
    if (!row) throw new Error("Missing conversation row");
    await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
}

beforeEach(() => {
    localStorage.clear();
    // These suites pin the per-event thread (Show the work ON = the pre-v6 rendering). The v6
    // default (OFF: one Under-the-hood card per turn) is covered in __tests__/turn-thread.test.tsx.
    localStorage.setItem(SHOW_THE_WORK_KEY, "true");
    resetShowTheWorkForTests();
});

describe("session-control banners", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("renders the persistent storage banner alongside a transient control error", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            preferencesUnavailable: true,
            controlError: "Couldn't save — device storage is full or unavailable.",
        };

        rendered = await renderClient(client);

        expect(
            [...rendered.container.querySelectorAll('[role="status"]')].map((element) => element.textContent),
        ).toEqual([PREFERENCES_UNAVAILABLE_ERROR, "Couldn't save — device storage is full or unavailable."]);
    });
});

describe("header compact + limits-reset (fork features)", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("compact button sends /snap-compact and shows an indeterminate in-flight pulse", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: { context: { tokens: 120_000, window: 200_000, pct: 60 } },
        };
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);

        rendered = await renderClient(client);

        const compact = button(rendered.container, "Compact conversation");
        expect(compact.textContent).toContain("Compact");
        expect(compact.className).not.toContain("mj_CompactButton_compacting");

        await act(async () => compact.click());

        // Guided safe-compact flow, not a raw /compact.
        expect(sendMessage).toHaveBeenCalledWith("/snap-compact");
        // Indeterminate in-flight feedback — pulse class + busy state, no % fill. The mock
        // resolve does not shrink context, so the pulse stays on (cleared only by a smaller
        // post-compact context frame or the timeout backstop).
        const busy = button(rendered.container, "Compact conversation");
        expect(busy.className).toContain("mj_CompactButton_compacting");
        expect(busy.getAttribute("aria-busy")).toBe("true");
        expect(busy.disabled).toBe(true);
        expect(busy.textContent).toContain("Compacting");
    });

    it("header shows the usage-window reset countdown instead of the workdir path", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: {
                model: "claude-opus-4-8",
                workdir: "/some/workspace/path",
                limits: [
                    {
                        id: "session",
                        label: "Session",
                        percent: 20,
                        resets_at_ms: Date.now() + 3 * 60 * 60_000,
                    },
                ],
            },
        };

        rendered = await renderClient(client);

        const reset = rendered.container.querySelector(".mj_HeaderLimitsReset");
        // Only the 5-hour window is present → a single value, no "/" divider.
        expect(reset?.textContent).toContain("resets");
        expect(reset?.textContent).toMatch(/resets\s+\d+h\d\d/); // "resets 3h00"
        expect(reset?.textContent).not.toContain("/");
        // The old workdir segment is gone — path never rendered.
        expect(rendered.container.querySelector(".mj_HeaderWorkdir")).toBeNull();
        expect(rendered.container.textContent).not.toContain("/some/workspace/path");
    });

    it("header shows both the 5-hour and weekly reset windows when present", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: {
                model: "claude-opus-4-8",
                limits: [
                    {
                        id: "session",
                        label: "Session",
                        percent: 20,
                        resets_at_ms: Date.now() + 3 * 60 * 60_000,
                    },
                    {
                        id: "week_all",
                        label: "Week (all)",
                        percent: 40,
                        resets_at_ms: Date.now() + 4 * 24 * 60 * 60_000,
                    },
                ],
            },
        };

        rendered = await renderClient(client);

        const reset = rendered.container.querySelector(".mj_HeaderLimitsReset");
        // Both windows → "resets <5h token> / <weekly token>" (bare values, "/" divider).
        expect(reset?.textContent).toContain("resets");
        expect(reset?.textContent).toContain("/");
        expect(reset?.textContent).toMatch(/resets\s+\d+h\d\d\s+\//); // 5h countdown leads
    });
});

describe("usage limit accessibility", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("names each progressbar and announces its percentage and reset", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: {
                limits: [{ label: "Session", percent: 39, resets: "in 2 hours" }],
            },
        };

        rendered = await renderClient(client);

        const group = rendered.container.querySelector('[role="group"][aria-label="Usage limits"]');
        const progressbar = group?.querySelector('[role="progressbar"]');
        // v5: the accessible name keeps the FULL server label; the visible tag is the
        // relabelled short form ("5h").
        expect(progressbar?.getAttribute("aria-label")).toBe("Session");
        expect(group?.querySelector(".mj_UsageLabel")?.textContent).toBe("5h");
        expect(progressbar?.getAttribute("aria-valuenow")).toBe("39");
        expect(progressbar?.getAttribute("aria-valuetext")).toBe("39% used, resets in 2 hours");
        expect(progressbar?.parentElement?.hasAttribute("aria-label")).toBe(false);
    });

    it("shows the effort level beside the model and the account email in the header subtitle", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: {
                model: "claude-sonnet",
                effort: "high",
                workdir: "/srv/app",
                email: "alice@example.com",
            },
        };

        rendered = await renderClient(client);

        const meta = rendered.container.querySelector(".mj_ChatHeader .mj_HeaderMeta");
        expect(meta?.querySelector(".mj_HeaderModel")?.textContent).toBe("claude-sonnet · high");
        expect(meta?.querySelector(".mj_HeaderEmail")?.textContent).toBe("alice@example.com");
        // The fork's header drops the workdir path; the account email follows the model.
        const segments = [...(meta?.children ?? [])].map((element) => element.className.split(" ")[0]);
        expect(segments.indexOf("mj_HeaderEmail")).toBeGreaterThan(segments.indexOf("mj_HeaderModel"));
    });

    it("leaves the model alone when no effort level is known, and drops the email when absent", async () => {
        const client = signedInClient();
        internals(client).state = { ...client.getSnapshot(), sessionStatus: { model: "claude-sonnet" } };

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_HeaderModel")?.textContent).toBe("claude-sonnet");
        expect(rendered.container.querySelector(".mj_HeaderEmail")).toBeNull();
    });

    it("offers to compact a conversation past the context threshold, sending /compact once", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: { context: { tokens: 512_300, window: 1_000_000, pct: 51 } },
        };
        let release: (sent: boolean) => void = () => {};
        const sendMessage = jest
            .spyOn(client, "sendMessage")
            .mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));

        rendered = await renderClient(client);

        const nudge = button(rendered.container, "Large conversation, 512 thousand tokens, compact it");
        expect(nudge.textContent).toContain("Large conversation (512k)");
        expect(nudge.textContent).toContain("Compact");
        await act(async () => nudge.click());
        // A second click while the first is still sending does not queue another /compact.
        await act(async () => nudge.click());
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith("/compact", client.getSnapshot().selectedConversationId);
        await act(async () => release(true));
        await act(async () => nudge.click());
        expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it("sends one /compact for a double-click, even once the first send has been queued", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: { context: { tokens: 512_300, window: 1_000_000, pct: 51 } },
        };
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);

        rendered = await renderClient(client);

        const nudge = rendered.container.querySelector<HTMLButtonElement>(".mj_CompactNudge")!;
        await act(async () => nudge.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
        await act(async () => nudge.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })));
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not nudge in a read-only subagent transcript", async () => {
        const result = await renderComposerAppWithChild("p1", "k1");
        rendered = result;
        const large = { context: { tokens: 512_300, window: 1_000_000, pct: 51 } };
        act(() =>
            (result.client as unknown as { patch(update: Partial<ClientState>): void }).patch({
                sessionStatus: large,
            }),
        );
        expect(result.container.querySelector(".mj_CompactNudge")).not.toBeNull();
        act(() =>
            (result.client as unknown as { patch(update: Partial<ClientState>): void }).patch({
                selectedConversationId: "k1",
                sessionStatus: large,
            }),
        );
        expect(result.container.querySelector(".mj_ReadOnlyHint")).not.toBeNull();
        expect(result.container.querySelector(".mj_CompactNudge")).toBeNull();
    });

    it("does not nudge at or below the context threshold", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: { context: { tokens: 400_000, window: 1_000_000, pct: 40 } },
        };

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_CompactNudge")).toBeNull();
    });

    it("fills only the semantic affirmative in a permission card, whatever the option order", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 0,
                    sender: "agent:claude",
                    type: "permission_request",
                    payload: { description: "Restart nginx on prod?", options: ["Always allow", "Deny", "Allow"] },
                },
            ],
        });

        rendered = await renderClient(client);

        const card = rendered.container.querySelector(".mj_PromptCard_permission");
        const filled = card?.querySelectorAll(".mj_PromptOption_affirmative");
        expect(filled?.length).toBe(1);
        expect(filled?.[0]?.textContent).toBe("Allow");
    });

    it("labels a denied tool as denied even when the exit code is 0", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 0,
                    sender: "agent:claude",
                    type: "tool_output",
                    payload: { command: "rm -rf /", exit_code: 0, denied: true, snippet: "" },
                },
            ],
        });

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_ToolCard summary .mj_ToolCard_status_failed")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_ToolCard_meta")?.textContent).toMatch(/^denied · /);
    });

    it("opens the header overflow menu with the selected conversation's actions", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);

        const trigger = button(rendered.container, "Conversation actions");
        expect(rendered.container.querySelector('.mj_HeaderOverflow [role="menu"]')).toBeNull();

        await act(async () => trigger.click());

        const menu = rendered.container.querySelector('.mj_HeaderOverflow [role="menu"]');
        expect(menu).not.toBeNull();
        const labels = Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map((item) =>
            item.textContent?.trim(),
        );
        // No status frame with `extras` yet: the browser-tools row is hidden, never guessed.
        expect(labels).toEqual(["Pin", "Add to Favorites", "Mark as unread", "Archive"]);
    });

    it("adds the browser-tools row once the bridge reports the session's extras", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...internals(client).state,
            sessionStatus: { model: "claude-fable-5", extras: [] },
        };
        const view = await renderClient(client);
        rendered = view;
        await act(async () => button(view.container, "Conversation actions").click());
        const menu = view.container.querySelector('.mj_HeaderOverflow [role="menu"]');
        const labels = Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map((item) =>
            item.textContent?.trim(),
        );
        expect(labels).toEqual(["Pin", "Add to Favorites", "Mark as unread", "Enable browser tools", "Archive"]);
    });

    it("opens the Tasks & decisions pane from the header, badged with this chat's items that need the user", async () => {
        const client = signedInClient();
        const waiting = (id: string, convo: string): unknown => ({
            id,
            num: Number(id.slice(3)),
            kind: "question",
            state: "open",
            awaiting: "user",
            origin_convo_id: convo,
        });
        internals(client).state = {
            ...client.getSnapshot(),
            inboxItems: [waiting("it_1", "c1"), waiting("it_2", "c1"), waiting("it_3", "c2")],
        } as ClientState;
        rendered = await renderClient(client);

        const toggle = button(rendered.container, "Tasks and decisions, 2 need you");
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        expect(toggle.querySelector(".mj_TrackerNeedsYouBadge_count")?.textContent).toBe("2");
        expect(rendered.container.querySelector(".mj_ChatTasks")).toBeNull();

        await act(async () => toggle.click());

        expect(rendered.container.querySelector('aside[aria-label="Tasks and decisions"]')).not.toBeNull();
        expect(toggle.getAttribute("aria-pressed")).toBe("true");

        await act(async () => button(rendered!.container, "Close tasks and decisions").click());
        expect(rendered.container.querySelector(".mj_ChatTasks")).toBeNull();
    });
});

describe("permission request cards", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    const permissionRequest = (expiresAt = Date.now() + 60_000): JournalEvent => ({
        seq: 42,
        convo_id: "c1",
        ts: 1,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            kind: "permission",
            tool_use_id: "toolu_123",
            description: 'Allow vercel tool "deploy_to_vercel"?',
            options: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
            ],
            expires_at: expiresAt,
            nonce: "nonce-123",
        },
    });

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("renders the bridge payload and keeps an enqueued Allow reply pending", async () => {
        const client = signedInClient({ events: [permissionRequest()] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);

        const card = rendered.container.querySelector(".mj_PromptCard_permission");
        expect(card?.textContent).toContain('Allow vercel tool "deploy_to_vercel"?');
        expect([...card!.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual([
            "Allow",
            "Deny",
        ]);

        const allow = [...card!.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "Allow",
        );
        await act(async () => allow?.click());

        expect(sendPromptReply.mock.calls[0]?.slice(0, 2)).toEqual([42, "allow"]);
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect(card?.querySelector(".mj_PromptResolved_allowed, .mj_PromptResolved_denied")).toBeNull();
        expect([...card!.querySelectorAll<HTMLButtonElement>("button")].every((candidate) => candidate.disabled)).toBe(
            true,
        );
    });

    it.each([
        ["allow", "allowed", "Allowed"],
        ["deny", "denied", "Denied"],
        ["always allow", "allowed", "Allowed"],
    ])("renders a durable %s reply with the %s treatment", async (choice, treatment, label) => {
        const request = permissionRequest();
        const reply: JournalEvent = {
            seq: 43,
            convo_id: "c1",
            ts: 2,
            sender: "user:alice",
            type: "prompt_reply",
            payload: { choice, target_seq: request.seq },
        };
        rendered = await renderClient(signedInClient({ events: [request, reply] }));

        const card = rendered.container.querySelector(".mj_PromptCard_permission");
        expect(card?.querySelector(`.mj_PromptResolved_${treatment}`)?.textContent).toBe(label);
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe(label);
    });

    it("resolves a pending local tap only when its durable reply arrives", async () => {
        const client = signedInClient();
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        rendered = { container, root };
        const request = permissionRequest();

        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event: request,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                }),
            );
        });
        const card = container.querySelector(".mj_PromptCard_permission");
        await act(async () => {
            [...card!.querySelectorAll<HTMLButtonElement>("button")]
                .find((candidate) => candidate.textContent === "Allow")
                ?.click();
        });

        expect(sendPromptReply).toHaveBeenCalledWith(request.seq, "allow", undefined);
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect(card?.querySelector(".mj_PromptResolved_allowed, .mj_PromptResolved_denied")).toBeNull();

        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event: request,
                    answeredPromptReplies: new Map([[`${request.convo_id}:${request.seq}`, { choice: "deny" }]]),
                }),
            );
        });

        expect(card?.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card?.querySelector(".mj_PromptResolved_denied")?.textContent).toBe("Denied");
    });

    it("resets its local answer when reused for a different event identity", async () => {
        const client = signedInClient();
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        rendered = { container, root };
        const firstRequest = permissionRequest();

        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event: firstRequest,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                }),
            );
        });
        await act(async () => {
            [...container.querySelectorAll<HTMLButtonElement>("button")]
                .find((candidate) => candidate.textContent === "Allow")
                ?.click();
        });
        expect(container.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        const nextRequest: JournalEvent = {
            ...permissionRequest(),
            seq: 43,
            payload: {
                ...firstRequest.payload,
                description: "Allow a different tool?",
            },
        };
        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event: nextRequest,
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                }),
            );
        });

        const card = container.querySelector(".mj_PromptCard_permission");
        expect(card?.textContent).toContain("Allow a different tool?");
        expect(card?.querySelector(".mj_PromptResolved")).toBeNull();
        expect([...card!.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual([
            "Allow",
            "Deny",
        ]);
        expect(sendPromptReply).toHaveBeenCalledTimes(1);

        await act(async () => {
            [...card!.querySelectorAll<HTMLButtonElement>("button")]
                .find((candidate) => candidate.textContent === "Deny")
                ?.click();
        });
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        await act(async () => {
            root.render(
                React.createElement(EventContent, {
                    client,
                    event: {
                        ...nextRequest,
                        convo_id: "c2",
                        payload: { ...nextRequest.payload, description: "Allow a tool in another conversation?" },
                    },
                    answeredPromptReplies: new Map<string, { choice?: string }>(),
                }),
            );
        });

        const conversationCard = container.querySelector(".mj_PromptCard_permission");
        expect(conversationCard?.textContent).toContain("Allow a tool in another conversation?");
        expect(conversationCard?.querySelector(".mj_PromptResolved")).toBeNull();
        expect(conversationCard?.querySelectorAll("button")).toHaveLength(2);
        expect(sendPromptReply).toHaveBeenCalledTimes(2);
    });

    it("keeps the generic resolved line for a non-permission prompt", async () => {
        const request: JournalEvent = {
            ...permissionRequest(),
            type: "prompt",
            payload: {
                question: "Choose a direction",
                options: ["Left", "Right"],
            },
        };
        const reply: JournalEvent = {
            seq: 43,
            convo_id: "c1",
            ts: 2,
            sender: "user:alice",
            type: "prompt_reply",
            payload: { choice: "deny", target_seq: request.seq },
        };
        rendered = await renderClient(signedInClient({ events: [request, reply] }));

        const resolved = rendered.container.querySelector(".mj_PromptCard .mj_PromptResolved");
        expect(resolved?.textContent).toBe("Answered");
        expect(resolved?.classList.contains("mj_PromptResolved_allowed")).toBe(false);
        expect(resolved?.classList.contains("mj_PromptResolved_denied")).toBe(false);
    });

    it.each([
        ["Allow", "allow"],
        ["Deny", "deny"],
    ])("still sends %s when the advisory client deadline has passed", async (label, choice) => {
        const client = signedInClient({ events: [permissionRequest(Date.now() - 1)] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);

        const card = rendered.container.querySelector(".mj_PromptCard_permission");
        expect(card?.querySelector(".mj_PromptResolved_expired")?.textContent).toBe("May have expired");
        expect(card?.querySelector(".mj_Expired")?.textContent).toBe("May have expired");
        expect(card?.querySelector(".mj_PromptResolved_allowed, .mj_PromptResolved_denied")).toBeNull();
        const buttons = [...card!.querySelectorAll<HTMLButtonElement>("button")];
        expect(buttons.map((button) => button.textContent)).toEqual(["Allow", "Deny"]);
        expect(buttons.every((button) => !button.disabled)).toBe(true);
        await act(async () => buttons.find((button) => button.textContent === label)?.click());
        expect(sendPromptReply).toHaveBeenCalledWith(42, choice, undefined);
    });

    it("keeps a reply pending when only its advisory client deadline passes", async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
        const client = signedInClient({ events: [permissionRequest(Date.now() + 1_000)] });
        jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard_permission");

        const allow = [...card!.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "Allow",
        );
        await act(async () => allow?.click());
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        await act(async () => jest.advanceTimersByTime(1_000));

        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        expect(card?.querySelector(".mj_PromptResolved_expired")?.textContent).toBe("May have expired");
        const buttons = [...card!.querySelectorAll<HTMLButtonElement>("button")];
        expect(buttons).toHaveLength(2);
        expect(buttons.every((button) => button.disabled)).toBe(true);
    });

    it("sends a late tap before a throttled advisory expiry timer can re-render", async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
        const client = signedInClient({ events: [permissionRequest(Date.now() + 1_000)] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard_permission");
        const allow = [...card!.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "Allow",
        );

        jest.setSystemTime(new Date("2026-08-06T12:00:01.000Z"));
        await act(async () => allow?.click());

        expect(sendPromptReply).toHaveBeenCalledWith(42, "allow", undefined);
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
        const buttons = [...card!.querySelectorAll<HTMLButtonElement>("button")];
        expect(buttons).toHaveLength(2);
        expect(buttons.every((button) => button.disabled)).toBe(true);
    });

    it("makes an unconfirmed reply without expires_at retryable after the confirmation window", async () => {
        jest.useFakeTimers();
        const request = permissionRequest();
        delete request.payload.expires_at;
        const client = signedInClient({ events: [request] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard_permission");
        const allow = [...card!.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "Allow",
        );

        await act(async () => allow?.click());
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");

        await act(async () => jest.advanceTimersByTime(10_000));

        expect(card?.querySelector(".mj_PromptResolved_pending")).toBeNull();
        expect(card?.querySelector(".mj_PromptResolved_retryable")?.textContent).toBe(
            "Reply not confirmed — tap to retry",
        );
        expect([...card!.querySelectorAll<HTMLButtonElement>("button")].every((button) => !button.disabled)).toBe(true);

        await act(async () => allow?.click());
        expect(sendPromptReply).toHaveBeenCalledTimes(2);
        expect(card?.querySelector(".mj_PromptResolved_pending")?.textContent).toBe("Sending…");
    });
});

describe("multi-select question cards", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    const pickManyPrompt = (payload: Record<string, unknown> = {}): JournalEvent => ({
        seq: 50,
        convo_id: "c1",
        ts: 1,
        sender: "agent:claude",
        type: "prompt",
        payload: {
            question: "Which checks should run?",
            mode: "pick_many",
            options: [
                { id: "opt_a", label: "Lint", value: "lint" },
                { id: "opt_b", label: "Unit tests", value: "unit" },
                { id: "opt_c", label: "Screenshots", value: "shots" },
            ],
            ...payload,
        },
    });

    const buttons = (card: Element): HTMLButtonElement[] => [...card.querySelectorAll<HTMLButtonElement>("button")];
    const byLabel = (card: Element, label: string): HTMLButtonElement =>
        buttons(card).find((button) => button.textContent === label)!;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("toggles options without sending, then sends the ticked values in option order", async () => {
        const client = signedInClient({ events: [pickManyPrompt()] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard")!;

        const send = byLabel(card, "Send");
        expect(send.classList.contains("mj_PromptOption_affirmative")).toBe(true);
        expect(send.disabled).toBe(true);
        expect(card.querySelectorAll(".mj_PromptOption_affirmative")).toHaveLength(1);
        const group = card.querySelector('[role="group"]')!;
        expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe(
            "Which checks should run?",
        );

        await act(async () => byLabel(card, "Screenshots").click());
        await act(async () => byLabel(card, "Lint").click());
        expect(sendPromptReply).not.toHaveBeenCalled();
        expect(byLabel(card, "Lint").getAttribute("aria-pressed")).toBe("true");
        expect(byLabel(card, "Unit tests").getAttribute("aria-pressed")).toBe("false");
        expect(send.disabled).toBe(false);

        await act(async () => send.click());

        expect(sendPromptReply).toHaveBeenCalledTimes(1);
        expect(sendPromptReply).toHaveBeenCalledWith(50, "lint, shots", undefined);
        expect(card.querySelector(".mj_PromptOptions")).toBeNull();
        expect(card.querySelector(".mj_PromptResolved")?.textContent).toBe("Answered");
    });

    it("unticks an option on a second tap, and disables Send once nothing is ticked", async () => {
        const client = signedInClient({ events: [pickManyPrompt()] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard")!;

        await act(async () => byLabel(card, "Unit tests").click());
        await act(async () => byLabel(card, "Unit tests").click());

        expect(byLabel(card, "Unit tests").getAttribute("aria-pressed")).toBe("false");
        expect(byLabel(card, "Send").disabled).toBe(true);
        await act(async () => byLabel(card, "Send").click());
        expect(sendPromptReply).not.toHaveBeenCalled();
    });

    it("sends plain string options by their label", async () => {
        const client = signedInClient({ events: [pickManyPrompt({ options: ["Red", "Green", "Blue"] })] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard")!;

        await act(async () => byLabel(card, "Blue").click());
        await act(async () => byLabel(card, "Green").click());
        await act(async () => byLabel(card, "Send").click());

        expect(sendPromptReply).toHaveBeenCalledWith(50, "Green, Blue", undefined);
    });

    it("keeps the ticks when the reply could not be sent", async () => {
        const client = signedInClient({ events: [pickManyPrompt()] });
        jest.spyOn(client, "sendPromptReply").mockReturnValue(false);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard")!;

        await act(async () => byLabel(card, "Lint").click());
        await act(async () => byLabel(card, "Send").click());

        expect(byLabel(card, "Lint").getAttribute("aria-pressed")).toBe("true");
        expect(byLabel(card, "Send").disabled).toBe(false);
    });

    it("shows a question answered elsewhere as resolved, without toggles", async () => {
        const reply: JournalEvent = {
            seq: 51,
            convo_id: "c1",
            ts: 2,
            sender: "user:alice",
            type: "prompt_reply",
            payload: { target_seq: 50, choice: "lint, unit" },
        };
        rendered = await renderClient(signedInClient({ events: [pickManyPrompt(), reply] }));
        const card = rendered.container.querySelector(".mj_PromptCard")!;

        expect(card.querySelector(".mj_PromptOption_toggle")).toBeNull();
        expect(card.querySelector(".mj_PromptResolved")?.textContent).toBe("Answered");
    });

    it("leaves a single-choice question sending on the first tap", async () => {
        const client = signedInClient({ events: [pickManyPrompt({ mode: "pick_one" })] });
        const sendPromptReply = jest.spyOn(client, "sendPromptReply").mockReturnValue(true);
        rendered = await renderClient(client);
        const card = rendered.container.querySelector(".mj_PromptCard")!;

        expect(card.querySelector(".mj_PromptOption_toggle")).toBeNull();
        await act(async () => byLabel(card, "Unit tests").click());
        expect(sendPromptReply).toHaveBeenCalledWith(50, "unit", undefined);
    });
});

describe("markdown render-site integration", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("renders markdown only for EventContent text events", async () => {
        const client = signedInClient();
        const text = textEvent(1, "**bold text**");
        const promptReply: JournalEvent = {
            ...textEvent(2, "unused"),
            type: "prompt_reply",
            payload: { choice: "**plain reply**" },
        };
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        rendered = { container, root };

        await act(async () => {
            root.render(
                React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(EventContent, {
                        client,
                        event: text,
                        answeredPromptReplies: new Map<string, { choice?: string }>(),
                    }),
                    React.createElement(EventContent, {
                        client,
                        event: promptReply,
                        answeredPromptReplies: new Map<string, { choice?: string }>(),
                    }),
                ),
            );
        });

        expect(container.querySelector(".mj_Markdown strong")?.textContent).toBe("bold text");
        const plainReply = container.querySelector(".mj_MessageText");
        expect(plainReply?.textContent).toBe("**plain reply**");
        expect(plainReply?.querySelector("strong")).toBeNull();
    });

    it("renders pending markdown and visually trails streaming prose with an external cursor", async () => {
        const client = signedInClient({
            pendingMessages: [{ localId: "pending-markdown", convoId: "c1", body: "**pending bold**", createdAt: 1 }],
        });
        internals(client).state = {
            ...client.getSnapshot(),
            textStreams: { response: "stream text" },
        };

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_EventTile_sending .mj_Markdown strong")?.textContent).toBe(
            "pending bold",
        );
        const cursor = rendered.container.querySelector(".mj_Cursor");
        const streamMarkdown = cursor?.parentElement;
        const terminalParagraph = streamMarkdown?.querySelector(":scope > p:nth-last-child(2)");
        expect(streamMarkdown?.classList.contains("mj_Markdown_streaming")).toBe(true);
        expect(terminalParagraph?.textContent).toBe("stream text");
        expect(terminalParagraph?.nextElementSibling).toBe(cursor);
        expect(cursor?.parentElement).toBe(streamMarkdown);
        expect(terminalParagraph?.contains(cursor ?? null)).toBe(false);
    });

    it("hides queued-release and legacy queue replies while keeping ordinary reply bubbles", async () => {
        const queuedReleasePrompt: JournalEvent = {
            ...textEvent(100, "unused"),
            type: "prompt",
            payload: { kind: "queued_release", body: "Queued item" },
        };
        const queueAction: JournalEvent = {
            ...textEvent(101, "unused"),
            type: "prompt_reply",
            payload: { choice: "send", target_seq: queuedReleasePrompt.seq },
        };
        const bridgeRelease: JournalEvent = {
            ...textEvent(102, "unused"),
            type: "prompt_reply",
            payload: { kind: "queued_release", prompt_id: "pr_1", action: "send", released: ["pr_1::0"] },
        };
        const ordinaryPrompt: JournalEvent = {
            ...textEvent(103, "unused"),
            type: "prompt",
            payload: {
                question: "Continue?",
                options: [
                    { id: "yes", label: "Yes", value: "Yes" },
                    { id: "cancel", label: "Cancel", value: "No" },
                ],
            },
        };
        const ordinaryReply: JournalEvent = {
            ...textEvent(104, "unused"),
            type: "prompt_reply",
            payload: { choice: "Yes", target_seq: ordinaryPrompt.seq },
        };
        const legacyPrompt: JournalEvent = {
            ...textEvent(105, "unused"),
            type: "prompt",
            payload: {
                question: "Queued item",
                options: [
                    { id: "interrupt", label: "Send now", value: "interrupt" },
                    { id: "cancel", label: "Cancel", value: "cancel:0" },
                ],
            },
        };
        const legacyInterruptReply: JournalEvent = {
            ...textEvent(106, "unused"),
            type: "prompt_reply",
            payload: { choice: "interrupt", target_seq: legacyPrompt.seq },
        };
        const legacyCancelReply: JournalEvent = {
            ...textEvent(107, "unused"),
            type: "prompt_reply",
            payload: { choice: "cancel:0", target_seq: legacyPrompt.seq },
        };
        const client = signedInClient({
            events: [
                queuedReleasePrompt,
                queueAction,
                bridgeRelease,
                ordinaryPrompt,
                ordinaryReply,
                legacyPrompt,
                legacyInterruptReply,
                legacyCancelReply,
            ],
        });

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(`[data-event-id="${queueAction.seq}"]`)).toBeNull();
        expect(rendered.container.querySelector(`[data-event-id="${bridgeRelease.seq}"]`)).toBeNull();
        expect(rendered.container.querySelector(`[data-event-id="${ordinaryReply.seq}"]`)?.textContent).toContain(
            "Yes",
        );
        const legacyCard = rendered.container.querySelector(`[data-event-id="${legacyPrompt.seq}"] .mj_PromptCard`);
        expect(legacyCard).not.toBeNull();
        expect(legacyCard?.classList.contains("mj_QueuedReleaseCard")).toBe(false);
        expect(rendered.container.querySelector(`[data-event-id="${legacyInterruptReply.seq}"]`)).toBeNull();
        expect(rendered.container.querySelector(`[data-event-id="${legacyCancelReply.seq}"]`)).toBeNull();
    });

    it("keeps an ordinary answer to a prompt that also contains a legacy-shaped option", async () => {
        const prompt: JournalEvent = {
            ...textEvent(108, "unused"),
            type: "prompt",
            payload: {
                question: "How should this continue?",
                options: [
                    { id: "continue", label: "Continue", value: "continue" },
                    { id: "interrupt", label: "Interrupt", value: "interrupt" },
                ],
            },
        };
        const ordinaryReply: JournalEvent = {
            ...textEvent(109, "unused"),
            type: "prompt_reply",
            payload: { choice: "continue", target_seq: prompt.seq },
        };
        const legacyControlReply: JournalEvent = {
            ...textEvent(110, "unused"),
            type: "prompt_reply",
            payload: { choice: "interrupt", target_seq: prompt.seq },
        };

        rendered = await renderClient(signedInClient({ events: [prompt, ordinaryReply, legacyControlReply] }));

        expect(rendered.container.querySelector(`[data-event-id="${ordinaryReply.seq}"]`)?.textContent).toContain(
            "continue",
        );
        expect(rendered.container.querySelector(`[data-event-id="${legacyControlReply.seq}"]`)).toBeNull();
    });

    it("derives queued-card resolution only from kind-marked release records", async () => {
        const genuinePrompt: JournalEvent = {
            ...textEvent(110, "unused"),
            type: "prompt",
            payload: {
                kind: "queued_release",
                items: [{ id: "pr_genuine::0", text: "Genuine release" }],
                actions: [{ id: "send", label: "Send", intent: "primary" }],
            },
        };
        const strayPrompt: JournalEvent = {
            ...textEvent(111, "unused"),
            type: "prompt",
            payload: {
                kind: "queued_release",
                items: [{ id: "pr_stray::0", text: "Stray release" }],
                actions: [{ id: "send", label: "Send", intent: "primary" }],
            },
        };
        const genuineRelease: JournalEvent = {
            ...textEvent(112, "unused"),
            type: "prompt_reply",
            payload: { kind: "queued_release", action: "send", released: ["pr_genuine::0"] },
        };
        const strayRelease: JournalEvent = {
            ...textEvent(113, "unused"),
            type: "prompt_reply",
            payload: { choice: "unrelated", action: "cancel", released: ["pr_stray::0"] },
        };

        rendered = await renderClient(
            signedInClient({ events: [genuinePrompt, strayPrompt, genuineRelease, strayRelease] }),
        );

        const genuineCard = rendered.container.querySelector(`[data-event-id="${genuinePrompt.seq}"]`);
        const strayCard = rendered.container.querySelector(`[data-event-id="${strayPrompt.seq}"]`);
        expect(genuineCard?.querySelector(".mj_Answered")?.textContent).toBe("Sent");
        expect(strayCard?.querySelector(".mj_Answered")).toBeNull();
        expect(strayCard?.querySelector("button")?.textContent).toBe("Send");
    });

    function queuedPrompt(seq: number, itemId: string): JournalEvent {
        return {
            ...textEvent(seq, "unused"),
            type: "prompt",
            payload: {
                kind: "queued_release",
                items: [{ id: itemId, text: "Queued item" }],
                actions: [
                    { id: "send", label: "Send", intent: "primary" },
                    { id: "cancel", label: "Cancel", intent: "neutral" },
                ],
            },
        };
    }
    function release(seq: number, action: string, itemId: string): JournalEvent {
        return {
            ...textEvent(seq, "unused"),
            type: "prompt_reply",
            payload: { kind: "queued_release", action, released: [itemId] },
        };
    }

    it("renders a terminal expired card (distinct label, no buttons) for an expired release (spec §6)", async () => {
        const prompt = queuedPrompt(200, "pr_exp::0");
        const expired = release(201, "expired", "pr_exp::0");
        rendered = await renderClient(signedInClient({ events: [prompt, expired] }));

        const card = rendered.container.querySelector(`[data-event-id="${prompt.seq}"]`);
        expect(card?.querySelector(".mj_PromptResolved_expired")).not.toBeNull();
        expect(card?.querySelector(".mj_Expired")?.textContent).toBe("Expired — no longer actionable");
        // Distinct from a real resolution — no "Sent"/"Cancelled" check row.
        expect(card?.querySelector(".mj_PromptGlyph_ok")).toBeNull();
        // Both buttons removed (not merely disabled) — terminal, non-actionable.
        expect(card?.querySelector("button")).toBeNull();
        // The expired release itself does not render as a literal thread bubble.
        expect(rendered.container.querySelector(`[data-event-id="${expired.seq}"]`)).toBeNull();
    });

    it("terminal precedence: a real resolution outranks expired in BOTH arrival orders (spec §6)", async () => {
        // (a) send THEN expired -> Sent
        const promptA = queuedPrompt(210, "pr_a::0");
        rendered = await renderClient(
            signedInClient({ events: [promptA, release(211, "send", "pr_a::0"), release(212, "expired", "pr_a::0")] }),
        );
        let card = rendered.container.querySelector(`[data-event-id="${promptA.seq}"]`);
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Sent");
        expect(card?.querySelector(".mj_PromptResolved_expired")).toBeNull();
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();

        // (b) expired THEN cancel -> Cancelled (never downgraded to expired)
        const promptB = queuedPrompt(213, "pr_b::0");
        rendered = await renderClient(
            signedInClient({
                events: [promptB, release(214, "expired", "pr_b::0"), release(215, "cancel", "pr_b::0")],
            }),
        );
        card = rendered.container.querySelector(`[data-event-id="${promptB.seq}"]`);
        expect(card?.querySelector(".mj_Answered")?.textContent).toBe("Cancelled");
        expect(card?.querySelector(".mj_PromptResolved_expired")).toBeNull();
    });
});

describe("isQueuedReleaseReply (queue-prompt provenance suppression)", () => {
    const reply = (payload: JournalEvent["payload"]): JournalEvent => ({
        seq: 1,
        convo_id: "c1",
        ts: 1,
        sender: "user:carol",
        type: "prompt_reply",
        payload,
    });
    const queuedReleasePromptSeqs = new Set([10]);
    const legacyQueuePromptSeqs = new Set([12]);

    it("hides a tap echo targeting a queued-release prompt seq", () => {
        expect(
            isQueuedReleaseReply(
                reply({ choice: "send", target_seq: 10 }),
                queuedReleasePromptSeqs,
                legacyQueuePromptSeqs,
            ),
        ).toBe(true);
    });

    it("hides a bridge-authored queued-release event", () => {
        expect(
            isQueuedReleaseReply(
                reply({ kind: "queued_release", prompt_id: "pr_1", action: "cancel", released: ["pr_1::0"] }),
                new Set(),
                new Set(),
            ),
        ).toBe(true);
    });

    it("keeps an ordinary prompt reply even when its choice resembles a queue action", () => {
        expect(
            isQueuedReleaseReply(
                reply({ choice: "interrupt", target_seq: 11 }),
                queuedReleasePromptSeqs,
                legacyQueuePromptSeqs,
            ),
        ).toBe(false);
        expect(
            isQueuedReleaseReply(
                reply({ choice: "cancel:5", target_seq: 11 }),
                queuedReleasePromptSeqs,
                legacyQueuePromptSeqs,
            ),
        ).toBe(false);
    });

    it("hides only legacy control choices targeting a provenance-identified legacy queue prompt", () => {
        expect(
            isQueuedReleaseReply(
                reply({ choice: "interrupt", target_seq: 12 }),
                queuedReleasePromptSeqs,
                legacyQueuePromptSeqs,
            ),
        ).toBe(true);
        expect(
            isQueuedReleaseReply(
                reply({ choice: "cancel:5", target_seq: 12 }),
                queuedReleasePromptSeqs,
                legacyQueuePromptSeqs,
            ),
        ).toBe(true);
        expect(
            isQueuedReleaseReply(
                reply({ choice: "continue", target_seq: 12 }),
                queuedReleasePromptSeqs,
                legacyQueuePromptSeqs,
            ),
        ).toBe(false);
    });

    it("keeps non-replies and replies without a numeric target seq", () => {
        const text: JournalEvent = {
            ...reply({ kind: "queued_release" }),
            type: "text",
            payload: { kind: "queued_release" },
        };
        expect(isQueuedReleaseReply(text, queuedReleasePromptSeqs, legacyQueuePromptSeqs)).toBe(false);
        expect(isQueuedReleaseReply(reply({ choice: "send" }), queuedReleasePromptSeqs, legacyQueuePromptSeqs)).toBe(
            false,
        );
    });
});

describe("isPermissionDecisionReply (permission-card provenance suppression)", () => {
    const reply = (payload: JournalEvent["payload"]): JournalEvent => ({
        seq: 2,
        convo_id: "c1",
        ts: 1,
        sender: "user:carol",
        type: "prompt_reply",
        payload,
    });
    const permissionRequestSeqs = new Set([20]);

    it("hides a decision reply targeting a permission_request seq (rendered inline on the card instead)", () => {
        expect(isPermissionDecisionReply(reply({ choice: "Allow", target_seq: 20 }), permissionRequestSeqs)).toBe(true);
        expect(isPermissionDecisionReply(reply({ choice: "Deny", target_seq: 20 }), permissionRequestSeqs)).toBe(true);
    });

    it("keeps an ordinary question reply (target seq is not a permission request)", () => {
        expect(isPermissionDecisionReply(reply({ choice: "Allow", target_seq: 21 }), permissionRequestSeqs)).toBe(
            false,
        );
    });

    it("keeps non-replies and replies without a numeric target seq", () => {
        const permReq: JournalEvent = { ...reply({}), type: "permission_request", payload: {} };
        expect(isPermissionDecisionReply(permReq, permissionRequestSeqs)).toBe(false);
        expect(isPermissionDecisionReply(reply({ choice: "Allow" }), permissionRequestSeqs)).toBe(false);
    });
});

function fileDragEvent(type: string, file: File): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [file] },
    });
    return event;
}

function inputTextarea(textarea: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function textEvent(seq: number, body: string): JournalEvent {
    return { seq, convo_id: "c1", ts: seq, sender: "agent", type: "text", payload: { body } };
}

function renderAppWithEvents(
    events: JournalEvent[],
    convoIds = ["c1"],
): Promise<{ container: HTMLDivElement; root: Root; client: MatronJournalClient }> {
    const conversations = convoIds.map((id) => ({ ...CONVERSATION, id, title: id }));
    const client = signedInWithRooms(conversations);
    internals(client).state = { ...client.getSnapshot(), events: events.filter((event) => event.convo_id === "c1") };
    internals(client).database = {
        events: jest.fn(async (convoId: string) => events.filter((event) => event.convo_id === convoId)),
        outbox: jest.fn(async () => []),
    };
    return renderClient(client).then((rendered) => ({ ...rendered, client }));
}

async function renderAppWithToolStream(): Promise<{
    container: HTMLDivElement;
    root: Root;
    client: MatronJournalClient;
}> {
    const client = signedInClient();
    internals(client).state = {
        ...client.getSnapshot(),
        toolStreams: {
            running: {
                messageRef: "running",
                content: "working",
                offset: 7,
                headTruncated: false,
                tool: "shell",
                command: "test",
            },
        },
    };
    return renderClient(client).then((rendered) => ({ ...rendered, client }));
}

describe("message model DOM contracts", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("renders a first-in-group non-self timestamp exactly once in the header", async () => {
        rendered = await renderClient(signedInClient({ events: [textEvent(1, "first")] }));

        const row = rendered.container.querySelector('[data-event-id="1"]');
        expect(row?.querySelectorAll("time")).toHaveLength(1);
        expect(row?.querySelectorAll(".mj_SenderName time")).toHaveLength(1);
        expect(row?.querySelectorAll(".mj_EventTile_line time")).toHaveLength(0);
    });

    it("puts the section timestamp on the first block and none on agent continuations", async () => {
        rendered = await renderClient(
            signedInClient({ events: [textEvent(1, "first"), textEvent(2, "continuation")] }),
        );

        const first = rendered.container.querySelector('[data-event-id="1"]');
        const row = rendered.container.querySelector('[data-event-id="2"]');
        expect(row?.classList.contains("mj_EventTile_continuation")).toBe(true);
        // The section's single timestamp lives on the first block's profile row.
        expect(first?.querySelectorAll(".mj_SenderName time")).toHaveLength(1);
        // Continuation blocks carry no per-block timestamp, so they fill to the shared
        // right edge with no reserved 56px gutter (kills the first-block spill).
        expect(row?.querySelectorAll("time")).toHaveLength(0);
    });

    it("renders a self timestamp exactly once and no avatar", async () => {
        const event = { ...textEvent(1, "self"), sender: "user:alice" };
        rendered = await renderClient(signedInClient({ events: [event] }));

        const row = rendered.container.querySelector('[data-event-id="1"]');
        expect(row?.querySelectorAll("time")).toHaveLength(1);
        expect(row?.querySelectorAll(".mj_EventTile_line time")).toHaveLength(1);
        expect(row?.querySelectorAll(".mj_MsgAvatar")).toHaveLength(0);
    });

    it("renders exactly one avatar at every non-self header site", async () => {
        const client = signedInClient({ events: [textEvent(1, "persisted")] });
        internals(client).state = {
            ...client.getSnapshot(),
            textStreams: { response: "streaming" },
            toolStreams: {
                running: {
                    messageRef: "running",
                    content: "working",
                    offset: 7,
                    headTruncated: false,
                    tool: "shell",
                    command: "test",
                },
            },
        };
        rendered = await renderClient(client);

        const eventRow = rendered.container.querySelector('[data-event-id="1"]');
        const textStreamRow = rendered.container.querySelector(".mj_Cursor")?.closest(".mj_EventTile");
        const toolStreamRow = rendered.container.querySelector(".mj_LiveTool")?.closest(".mj_EventTile");
        expect(eventRow?.querySelectorAll(".mj_MsgAvatar")).toHaveLength(1);
        expect(textStreamRow?.querySelectorAll(".mj_MsgAvatar")).toHaveLength(1);
        expect(toolStreamRow?.querySelectorAll(".mj_MsgAvatar")).toHaveLength(1);

        const avatar = eventRow?.querySelector<HTMLElement>(".mj_MsgAvatar");
        expect(avatar?.tagName).toBe("SPAN");
        expect(avatar?.getAttribute("aria-hidden")).toBe("true");
        expect(avatar?.style.maskImage).toContain("matron-logo");
    });
});

async function rightClick(node: Element): Promise<void> {
    await act(async () => {
        node.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 32 }),
        );
    });
}

async function openRowMenu(container: HTMLElement, seq: number): Promise<void> {
    const row = container.querySelector(`[data-event-id="${seq}"]`);
    if (!row) throw new Error(`Missing event row: ${seq}`);
    await rightClick(row);
}

async function clickMenuItem(container: HTMLElement, label: string): Promise<void> {
    const item = [...container.querySelectorAll<HTMLButtonElement>('.mj_EventRowMenu [role="menuitem"]')].find(
        (candidate) => candidate.textContent === label,
    );
    if (!item) throw new Error(`Missing menu item: ${label}`);
    await act(async () => item.click());
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
    const item = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
    );
    if (!item) throw new Error(`Missing button: ${label}`);
    await act(async () => item.click());
}

function renderComposerApp(
    convoIds: string[],
    client?: MatronJournalClient,
): Promise<{ container: HTMLDivElement; root: Root; client: MatronJournalClient }> {
    if (client) {
        const conversations = convoIds.map((id) => ({ ...CONVERSATION, id, title: id }));
        internals(client).state = {
            ...client.getSnapshot(),
            conversations,
            selectedConversationId: convoIds[0] ?? null,
            events: [],
        };
        internals(client).database = {
            events: jest.fn(async () => []),
            outbox: jest.fn(async () => []),
        };
        return renderClient(client).then((rendered) => ({ ...rendered, client }));
    }
    return renderAppWithEvents([], convoIds);
}

function renderComposerAppWithChild(
    parentId: string,
    childId: string,
): Promise<{ container: HTMLDivElement; root: Root; client: MatronJournalClient }> {
    const parent = { ...CONVERSATION, id: parentId, title: parentId };
    const child = { ...CONVERSATION, id: childId, title: childId, parent_convo_id: parentId };
    const client = signedInWithRooms([parent, child]);
    internals(client).state = { ...client.getSnapshot(), selectedConversationId: parentId };
    internals(client).database = {
        events: jest.fn(async () => []),
        outbox: jest.fn(async () => []),
    };
    return renderClient(client).then((rendered) => ({ ...rendered, client }));
}

function composerValue(container: HTMLElement): string {
    const textarea = container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input");
    if (!textarea) throw new Error("Missing composer textarea");
    return textarea.value;
}

async function typeInComposer(container: HTMLElement, value: string): Promise<void> {
    const textarea = container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input");
    if (!textarea) throw new Error("Missing composer textarea");
    await act(async () => inputTextarea(textarea, value));
}

async function pressEnter(container: HTMLElement): Promise<void> {
    const textarea = container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input");
    if (!textarea) throw new Error("Missing composer textarea");
    await keydown(textarea, "Enter");
}

async function selectFirstPaletteItem(container: HTMLElement): Promise<void> {
    const item = container.querySelector<HTMLElement>('[role="option"]');
    if (!item) throw new Error("Missing palette item");
    await act(async () => item.click());
}

async function touchPress(node: Element, pointerId = 1): Promise<void> {
    const event = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 18,
    });
    Object.defineProperties(event, {
        pointerType: { value: "touch" },
        pointerId: { value: pointerId },
    });
    await act(async () => node.dispatchEvent(event));
}

async function keydown(
    element: Element,
    key: string,
    options: KeyboardEventInit & { keyCode?: number } = {},
): Promise<{ event: KeyboardEvent; dispatched: boolean }> {
    const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
    });
    if (options.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: options.keyCode });
    let dispatched = true;
    await act(async () => {
        dispatched = element.dispatchEvent(event);
        await Promise.resolve();
    });
    return { event, dispatched };
}

describe("slash command palette", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        (Element.prototype.scrollIntoView as jest.Mock).mockClear();
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    const composer = (): HTMLTextAreaElement => {
        const textarea = rendered?.container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input");
        if (!textarea) throw new Error("Missing composer textarea");
        return textarea;
    };

    const options = (): HTMLElement[] => [
        ...(rendered?.container.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    ];

    it("associates the composer instructions with the textarea", async () => {
        rendered = await renderClient(signedInClient());

        const descriptionId = composer().getAttribute("aria-describedby");
        expect(descriptionId).toBe("mj-composer-hint");
        expect(document.getElementById(descriptionId!)?.textContent).toContain("/ commands · shift+enter for newline");
    });

    it("opens command rows for a slash-command prefix", async () => {
        rendered = await renderClient(signedInClient());

        await act(async () => inputTextarea(composer(), "/st"));

        expect(rendered.container.querySelector('[role="listbox"]')).not.toBeNull();
        expect(options().map((row) => row.querySelector(".mj_SlashPalette_trigger")?.textContent)).toEqual([
            "/start",
            "/stop",
            "/status",
        ]);
    });

    it("highlights with ArrowDown and selects with Enter without sending", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const arrow = await keydown(composer(), "ArrowDown");
        expect(arrow.dispatched).toBe(false);
        expect(arrow.event.defaultPrevented).toBe(true);
        expect(options()[0].getAttribute("aria-selected")).toBe("true");

        const enter = await keydown(composer(), "Enter");
        expect(enter.dispatched).toBe(false);
        expect(enter.event.defaultPrevented).toBe(true);
        expect(composer().value).toBe("/start ");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("leaves Shift+Enter untouched when a row is highlighted", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));
        await keydown(composer(), "ArrowDown");

        const shifted = await keydown(composer(), "Enter", { shiftKey: true });

        expect(shifted.dispatched).toBe(true);
        expect(shifted.event.defaultPrevented).toBe(false);
        expect(composer().value).toBe("/st");
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("sends the literal body on Enter when no row is highlighted", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const enter = await keydown(composer(), "Enter");

        expect(enter.dispatched).toBe(false);
        expect(enter.event.defaultPrevented).toBe(true);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith("/st", "c1");
    });

    it("dismisses the palette with Escape without changing the body", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const escape = await keydown(composer(), "Escape");

        expect(escape.dispatched).toBe(false);
        expect(escape.event.defaultPrevented).toBe(true);
        expect(rendered.container.querySelector('[role="listbox"]')).toBeNull();
        expect(composer().value).toBe("/st");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("completes the first row with Tab", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));

        const tab = await keydown(composer(), "Tab");

        expect(tab.dispatched).toBe(false);
        expect(tab.event.defaultPrevented).toBe(true);
        expect(composer().value).toBe("/start ");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("does not select, send, or cancel IME Enter events", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/st"));
        await keydown(composer(), "ArrowDown");

        const composing = await keydown(composer(), "Enter", { isComposing: true });
        const legacyComposing = await keydown(composer(), "Enter", { keyCode: 229 });

        for (const result of [composing, legacyComposing]) {
            expect(result.dispatched).toBe(true);
            expect(result.event.defaultPrevented).toBe(false);
        }
        expect(composer().value).toBe("/st");
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("highlights and click-selects a recent folder exactly once", async () => {
        makeRecentFoldersStore(SESSION).record("/srv/Project");
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/workdir /srv/P"));
        expect(options().map((row) => row.textContent)).toEqual(["/srv/Project"]);

        await act(async () =>
            options()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true })),
        );
        expect(options()[0].getAttribute("aria-selected")).toBe("true");
        expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

        const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        await act(async () => options()[0].dispatchEvent(mouseDown));
        expect(mouseDown.defaultPrevented).toBe(true);
        expect(composer().value).toBe("/workdir /srv/P");

        await act(async () => options()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
        expect(composer().value).toBe("/workdir /srv/Project");
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("offers a command's flags after it, and a pick fills the composer ready for the next", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/start "));
        expect(options().map((row) => row.querySelector(".mj_SlashPalette_trigger")?.textContent)).toEqual([
            "--claude",
            "--codex",
            "--browser",
        ]);
        expect(options()[1].querySelector(".mj_SlashPalette_summary")?.textContent).toBe("Use the Codex agent");

        await keydown(composer(), "ArrowDown");
        await keydown(composer(), "ArrowDown");
        await keydown(composer(), "Enter");
        expect(composer().value).toBe("/start --codex ");
        // --claude and --browser both conflict with --codex: nothing left to offer.
        expect(options()).toHaveLength(0);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("lists arguments ahead of recent folders and completes a flag with Tab", async () => {
        makeRecentFoldersStore(SESSION).record("/srv/app");
        rendered = await renderClient(signedInClient());
        await act(async () => inputTextarea(composer(), "/start "));
        expect(options().map((row) => row.textContent)).toEqual([
            "--claudeUse the Claude agent",
            "--codexUse the Codex agent",
            "--browserAdd browser tools (chrome-devtools MCP)",
            "/srv/app",
        ]);

        await act(async () => inputTextarea(composer(), "/start --b"));
        await keydown(composer(), "Tab");
        expect(composer().value).toBe("/start --browser ");
        expect(options().map((row) => row.textContent)).toEqual(["--claudeUse the Claude agent", "/srv/app"]);
    });

    it("offers the session's own models for /model, by label", async () => {
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: {
                model_options: [
                    { value: "opus", label: "Opus" },
                    { value: "opus[1m]", label: "Opus 1M" },
                ],
            },
        };
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/model op"));
        expect(options().map((row) => row.textContent)).toEqual(["Opus", "Opus 1M"]);

        await act(async () => options()[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
        expect(composer().value).toBe("/model opus[1m] ");
    });

    it("sends rather than picking when a status frame shortens the list under the highlight", async () => {
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        internals(client).state = {
            ...client.getSnapshot(),
            sessionStatus: { model_options: [{ value: "opus" }, { value: "sonnet" }] },
        };
        rendered = await renderClient(client);
        await act(async () => inputTextarea(composer(), "/model "));
        await keydown(composer(), "ArrowUp");
        expect(options()[1].getAttribute("aria-selected")).toBe("true");

        await act(async () => internals(client).patch({ sessionStatus: { model_options: [{ value: "opus" }] } }));
        expect(options()).toHaveLength(1);
        await keydown(composer(), "Enter");
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("records only folder commands accepted by sendMessage", async () => {
        const store = makeRecentFoldersStore(SESSION);
        const client = signedInClient();
        const sendMessage = jest.spyOn(client, "sendMessage").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        rendered = await renderClient(client);

        await act(async () => inputTextarea(composer(), "/workdir /op/accepted"));
        await keydown(composer(), "Enter");
        expect(store.matches("")).toContain("/op/accepted");
        const acceptedSnapshot = JSON.stringify(store.matches(""));

        await act(async () => inputTextarea(composer(), "/workdir /op/rejected"));
        await keydown(composer(), "Enter");

        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(store.matches("")).not.toContain("/op/rejected");
        expect(JSON.stringify(store.matches(""))).toBe(acceptedSnapshot);
    });
});

describe("composer drafts", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    test("draft persists per conversation across navigation", async () => {
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "draft for one");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(composerValue(rendered.container)).toBe("");
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe("draft for one");
    });

    test("a completion pick (folder) is persisted", async () => {
        jest.spyOn(require("../../../src/journal/slash-palette"), "makeRecentFoldersStore").mockReturnValue({
            record: jest.fn(),
            matches: () => ["work/dir"],
        });
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "/workdir wo");
        await selectFirstPaletteItem(rendered.container);
        const composed = composerValue(rendered.container);
        expect(composed).not.toBe("/workdir wo");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe(composed);
    });

    test("a throwing setItem does not lose the draft on navigation", async () => {
        const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("q", "QuotaExceededError");
        });
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "kept in memory");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe("kept in memory");
        spy.mockRestore();
    });

    test("keystroke debounces the localStorage write (no setItem before 250ms, one after)", async () => {
        jest.useFakeTimers();
        const setItem = jest.spyOn(Storage.prototype, "setItem");
        const result = await renderComposerApp(["c1"]);
        rendered = result;
        setItem.mockClear();
        await typeInComposer(rendered.container, "x");
        expect(setItem).not.toHaveBeenCalled();
        await act(async () => {
            jest.advanceTimersByTime(250);
        });
        expect(setItem).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test("pagehide flushes a pending draft write within the debounce window", async () => {
        jest.useFakeTimers();
        const setItem = jest.spyOn(Storage.prototype, "setItem");
        const result = await renderComposerApp(["c1"]);
        rendered = result;
        await typeInComposer(result.container, "unsaved edit");
        setItem.mockClear();
        await act(async () => {
            window.dispatchEvent(new Event("pagehide"));
        });
        expect(setItem).toHaveBeenCalled();
        jest.useRealTimers();
    });

    test("unmount (switch to read-only child) within the debounce window flushes the draft (round-4 B1)", async () => {
        jest.useFakeTimers();
        const result = await renderComposerAppWithChild("c1", "c1-child");
        rendered = result;
        await typeInComposer(result.container, "edit before unmount");
        await act(async () => {
            await result.client.selectConversation("c1-child");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("edit before unmount");
        jest.useRealTimers();
    });

    test("a failed draft persist surfaces the non-durable badge", async () => {
        jest.useFakeTimers();
        const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("q", "QuotaExceededError");
        });
        const result = await renderComposerApp(["c1"]);
        rendered = result;
        expect(result.container.querySelector(".mj_DraftNonDurable")).toBeNull();
        await typeInComposer(result.container, "unsaveable");
        await act(async () => {
            jest.advanceTimersByTime(250);
        });
        expect(result.container.querySelector(".mj_DraftNonDurable")).not.toBeNull();
        spy.mockRestore();
        jest.useRealTimers();
    });

    test("the non-durable badge survives switching away and back (round-6 B2)", async () => {
        jest.useFakeTimers();
        const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("q", "QuotaExceededError");
        });
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(result.container, "unsaveable");
        await act(async () => {
            jest.advanceTimersByTime(250);
        });
        expect(result.container.querySelector(".mj_DraftNonDurable")).not.toBeNull();
        // Switch away to c2 (never failed) → badge clears (synced from c2's ok flag).
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(result.container.querySelector(".mj_DraftNonDurable")).toBeNull();
        // Switch back to c1 → badge reappears (synced FROM the store, not a blind reset).
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(result.container.querySelector(".mj_DraftNonDurable")).not.toBeNull();
        spy.mockRestore();
        jest.useRealTimers();
    });
});

describe("composer sends", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    test("send glyph appears only with text and sends when clicked (Mac composer)", async () => {
        const client = signedInClient();
        const send = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        const result = await renderComposerApp(["c1"], client);
        rendered = result;

        const sendButton = () => result.container.querySelector<HTMLButtonElement>(".mj_ComposerSend");
        // Absent while the composer is empty (the Mac shows nothing to press).
        expect(sendButton()).toBeNull();

        await typeInComposer(result.container, "hi");
        expect(sendButton()).not.toBeNull();

        await act(async () => sendButton()!.click());
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith("hi", "c1");
    });

    test("two rapid Enters send once", async () => {
        let resolve!: (value: boolean) => void;
        const client = signedInClient();
        const send = jest
            .spyOn(client, "sendMessage")
            .mockReturnValue(new Promise((promiseResolve) => (resolve = promiseResolve)));
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "hi");
        await pressEnter(result.container);
        await pressEnter(result.container);
        expect(send).toHaveBeenCalledTimes(1);
        await act(async () => {
            resolve(true);
        });
    });

    test("a late send in A does not strand B's unsent draft typed during the pending send (final-review round-2)", async () => {
        let resolveA!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveA = promiseResolve)),
        );
        const result = await renderComposerApp(["c1", "c2"], client);
        rendered = result;
        await typeInComposer(result.container, "A-msg");
        await pressEnter(result.container); // A send pending
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await typeInComposer(result.container, "B-draft-unsent"); // schedules B's shared debounce timer
        await act(async () => {
            resolveA(true); // A resolves → cancels the shared timer + clears A
        });
        // B's draft must have been flushed (persisted) before the timer was cancelled, so switching
        // away and back restores it — not silently stranded.
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(composerValue(result.container)).toBe("B-draft-unsent");
    });

    test("a successful send whose draft clear fails does NOT resurrect the sent text (final-review M1)", async () => {
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "sent then clear-fails");
        // removeItem throws during drafts.clear(cid); the in-memory empty tombstone must keep read()
        // returning "" so reloadDraft after the send does not put the already-sent text back.
        jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new DOMException("denied", "SecurityError");
        });
        await pressEnter(result.container);
        expect(composerValue(result.container)).toBe("");
    });

    test("cross-convo: send in A pending, Enter in B not blocked; A resolve leaves B untouched; A draft cleared", async () => {
        let resolveA!: (value: boolean) => void;
        const client = signedInClient();
        const send = jest
            .spyOn(client, "sendMessage")
            .mockReturnValueOnce(new Promise((promiseResolve) => (resolveA = promiseResolve)))
            .mockResolvedValue(true);
        const result = await renderComposerApp(["c1", "c2"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await typeInComposer(result.container, "B-msg");
        await pressEnter(result.container);
        expect(send).toHaveBeenNthCalledWith(2, "B-msg", "c2");
        await act(async () => {
            resolveA(true);
        });
        expect(composerValue(result.container)).toBe("");
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("");
    });

    test("same-convo interleave: follow-up Y typed during a pending send is preserved", async () => {
        let resolveX!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveX = promiseResolve)),
        );
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await typeInComposer(result.container, "Y");
        await act(async () => {
            resolveX(true);
        });
        expect(composerValue(result.container)).toBe("Y");
        expect(makeDraftStore(SESSION).read("c1").text).toBe("Y");
    });

    test("same-convo ABA interleave: a re-typed X during a pending X send is preserved", async () => {
        let resolveX!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveX = promiseResolve)),
        );
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await typeInComposer(result.container, "Y");
        await typeInComposer(result.container, "X");
        await act(async () => {
            resolveX(true);
        });
        expect(composerValue(result.container)).toBe("X");
        expect(makeDraftStore(SESSION).read("c1").text).toBe("X");
    });

    test("late resolve after a conversation switch does not resurrect the sent draft", async () => {
        let resolveX!: (value: boolean) => void;
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockReturnValueOnce(
            new Promise((promiseResolve) => (resolveX = promiseResolve)),
        );
        const result = await renderComposerApp(["c1", "c2"], client);
        rendered = result;
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await act(async () => {
            resolveX(true);
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("");
        expect(makeDraftStore(SESSION).read("c1").text).toBe("");
    });

    test("recent-folder is recorded on a successful folder-bearing send", async () => {
        const record = jest.fn();
        jest.spyOn(require("../../../src/journal/slash-palette"), "makeRecentFoldersStore").mockReturnValue({
            record,
            matches: () => [],
        });
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "/start work/dir do it");
        await pressEnter(result.container);
        await act(async () => undefined);
        expect(record).toHaveBeenCalledWith("work/dir");
    });

    test("an addToOutbox rejection is caught (no unhandled rejection), text retained, lock released", async () => {
        const client = signedInClient();
        jest.spyOn(client, "sendMessage").mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "hi");
        await pressEnter(result.container);
        await act(async () => undefined);
        expect(composerValue(result.container)).toBe("hi");
        jest.spyOn(client, "sendMessage").mockResolvedValueOnce(true);
        await pressEnter(result.container);
        await act(async () => undefined);
        expect(composerValue(result.container)).toBe("");
    });

    test("remount clears a resolved send and a post-resolution Enter does not duplicate", async () => {
        let resolveX!: (value: boolean) => void;
        const result = await renderComposerAppWithChild("c1", "c1-child");
        rendered = result;
        const send = jest
            .spyOn(result.client, "sendMessage")
            .mockReturnValueOnce(new Promise((promiseResolve) => (resolveX = promiseResolve)));
        await typeInComposer(result.container, "X");
        await pressEnter(result.container);
        await act(async () => {
            await result.client.selectConversation("c1-child");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("X");
        await act(async () => {
            resolveX(true);
        });
        expect(composerValue(result.container)).toBe("");
        await pressEnter(result.container);
        expect(send).toHaveBeenCalledTimes(1);
    });

    // jsdom has no layout: stand in for the content height the browser measures (24px a line).
    function stubLineHeights(): void {
        jest.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
            const value = (this as HTMLTextAreaElement).value ?? "";
            return value ? value.split("\n").length * 24 : 0;
        });
    }

    function composerHeight(container: HTMLElement): string {
        return container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input")!.style.height;
    }

    test("a draft restored on switching back keeps its typed height, capped at the max", async () => {
        stubLineHeights();
        const result = await renderComposerApp(["c1", "c2"]);
        rendered = result;
        await typeInComposer(rendered.container, "one\ntwo\nthree\nfour");
        expect(composerHeight(rendered.container)).toBe("96px");
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(composerHeight(rendered.container)).toBe("auto");
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(rendered.container)).toBe("one\ntwo\nthree\nfour");
        expect(composerHeight(rendered.container)).toBe("96px");

        await typeInComposer(rendered.container, "x\n".repeat(20));
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerHeight(rendered.container)).toBe("160px");
    });

    test("a draft restored into a freshly mounted composer opens at its content height", async () => {
        stubLineHeights();
        const result = await renderComposerAppWithChild("c1", "c1-child");
        rendered = result;
        await typeInComposer(result.container, "alpha\nbeta\ngamma");
        // The read-only child unmounts the composer; coming back mounts a new one from the draft.
        await act(async () => {
            await result.client.selectConversation("c1-child");
        });
        expect(result.container.querySelector(".mj_ComposerInput_input")).toBeNull();
        await act(async () => {
            await result.client.selectConversation("c1");
        });
        expect(composerValue(result.container)).toBe("alpha\nbeta\ngamma");
        expect(composerHeight(result.container)).toBe("72px");
    });

    test("a send clears the box back to its one-row height", async () => {
        stubLineHeights();
        const result = await renderComposerApp(["c1"]);
        rendered = result;
        jest.spyOn(result.client, "sendMessage").mockResolvedValue(true);
        await typeInComposer(rendered.container, "one\ntwo");
        expect(composerHeight(rendered.container)).toBe("48px");
        await pressEnter(rendered.container);
        expect(composerValue(rendered.container)).toBe("");
        expect(composerHeight(rendered.container)).toBe("auto");
    });
});

describe("stop turn button", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    const stopButton = (container: HTMLElement): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Stop the current turn"]');

    function patchState(client: MatronJournalClient, update: Partial<ClientState>): void {
        act(() => (client as unknown as { patch(update: Partial<ClientState>): void }).patch(update));
    }

    test("shows while the turn runs and sends !esc without touching the draft", async () => {
        const client = signedInClient();
        const send = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await typeInComposer(result.container, "half-written");

        expect(stopButton(result.container)).not.toBeNull();
        await act(async () => stopButton(result.container)!.click());

        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith("!esc", "c1");
        expect(composerValue(result.container)).toBe("half-written");
    });

    test("is absent when no turn is running", async () => {
        const client = signedInWithRooms([{ ...CONVERSATION, session_state: "done" }]);
        rendered = await renderClient(client);
        expect(stopButton(rendered.container)).toBeNull();
    });

    test("a second tap while the first is still sending is ignored", async () => {
        let resolve!: (value: boolean) => void;
        const client = signedInClient();
        const send = jest
            .spyOn(client, "sendMessage")
            .mockReturnValue(new Promise((promiseResolve) => (resolve = promiseResolve)));
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        await act(async () => stopButton(result.container)!.click());
        await act(async () => stopButton(result.container)!.click());
        expect(send).toHaveBeenCalledTimes(1);
        await act(async () => resolve(true));
        await act(async () => stopButton(result.container)!.click());
        expect(send).toHaveBeenCalledTimes(2);
    });

    test("lingers briefly after the turn ends, then hides", async () => {
        jest.useFakeTimers();
        const client = signedInClient();
        const result = await renderComposerApp(["c1"], client);
        rendered = result;
        expect(stopButton(result.container)).not.toBeNull();

        patchState(client, { conversations: [{ ...CONVERSATION, session_state: "done" }] });
        expect(stopButton(result.container)).not.toBeNull();
        act(() => jest.advanceTimersByTime(499));
        expect(stopButton(result.container)).not.toBeNull();
        act(() => jest.advanceTimersByTime(1));
        expect(stopButton(result.container)).toBeNull();
    });

    test("hides at once on switching to a conversation with no running turn", async () => {
        const running = { ...CONVERSATION, id: "c1", title: "c1" };
        const idle = { ...CONVERSATION, id: "c2", title: "c2", session_state: "done" };
        const client = signedInWithRooms([running, idle]);
        rendered = await renderClient(client);
        expect(stopButton(rendered.container)).not.toBeNull();

        patchState(client, { selectedConversationId: "c2" });
        expect(stopButton(rendered.container)).toBeNull();
    });

    test("a turn that just ended does not bring Stop back on returning to it", async () => {
        jest.useFakeTimers();
        const client = signedInWithRooms([
            { ...CONVERSATION, id: "c1", title: "c1" },
            { ...CONVERSATION, id: "c2", title: "c2", session_state: "done" },
        ]);
        rendered = await renderClient(client);
        patchState(client, {
            conversations: [
                { ...CONVERSATION, id: "c1", title: "c1", session_state: "done" },
                { ...CONVERSATION, id: "c2", title: "c2", session_state: "done" },
            ],
        });
        patchState(client, { selectedConversationId: "c2" });
        patchState(client, { selectedConversationId: "c1" });
        expect(stopButton(rendered.container)).toBeNull();
    });

    test("a Stop still sending in one conversation does not block Stop in another", async () => {
        const client = signedInWithRooms([
            { ...CONVERSATION, id: "c1", title: "c1" },
            { ...CONVERSATION, id: "c2", title: "c2" },
        ]);
        const send = jest.spyOn(client, "sendMessage").mockReturnValue(new Promise<boolean>(() => {}));
        rendered = await renderClient(client);
        await act(async () => stopButton(rendered!.container)!.click());
        patchState(client, { selectedConversationId: "c2" });
        await act(async () => stopButton(rendered!.container)!.click());
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith("!esc", "c2");
    });

    test("is not offered in a read-only subagent transcript", async () => {
        const result = await renderComposerAppWithChild("p1", "k1");
        rendered = result;
        patchState(result.client, { selectedConversationId: "k1" });
        expect(result.container.querySelector(".mj_ReadOnlyHint")).not.toBeNull();
        expect(stopButton(result.container)).toBeNull();
    });
});

describe("composer sent-message recall", () => {
    let rendered: { container: HTMLDivElement; root: Root; client: MatronJournalClient } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    const textarea = (): HTMLTextAreaElement =>
        rendered!.container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input")!;
    const value = (): string => composerValue(rendered!.container);
    const arrow = (key: "ArrowUp" | "ArrowDown") => keydown(textarea(), key);

    async function renderWithSends(convoIds = ["c1", "c2"]): Promise<jest.SpyInstance> {
        rendered = await renderComposerApp(convoIds);
        return jest.spyOn(rendered.client, "sendMessage").mockResolvedValue(true);
    }

    async function sendText(text: string): Promise<void> {
        await typeInComposer(rendered!.container, text);
        await pressEnter(rendered!.container);
    }

    async function select(convoId: string): Promise<void> {
        await act(async () => {
            await rendered!.client.selectConversation(convoId);
        });
    }

    test("Up and Down walk this conversation's sent messages from an empty field", async () => {
        await renderWithSends();
        await sendText("first");
        await sendText("second");
        expect(value()).toBe("");

        const up = await arrow("ArrowUp");
        expect(up.dispatched).toBe(false);
        expect(value()).toBe("second");
        await arrow("ArrowUp");
        expect(value()).toBe("first");
        // At the oldest entry Up stays put.
        await arrow("ArrowUp");
        expect(value()).toBe("first");
        await arrow("ArrowDown");
        expect(value()).toBe("second");
        // Past the newest, the (empty) draft the walk started from comes back.
        await arrow("ArrowDown");
        expect(value()).toBe("");
        // The walk is over: Down does nothing more.
        const down = await arrow("ArrowDown");
        expect(down.dispatched).toBe(true);
    });

    test("Up leaves a non-empty draft alone so the caret can move through it", async () => {
        await renderWithSends();
        await sendText("sent");
        await typeInComposer(rendered!.container, "line one\nline two");
        const up = await arrow("ArrowUp");
        expect(up.dispatched).toBe(true);
        expect(value()).toBe("line one\nline two");
    });

    test("arrows with a modifier keep their caret meaning and never recall", async () => {
        await renderWithSends();
        await sendText("sent");
        for (const modifier of ["shiftKey", "altKey", "metaKey", "ctrlKey"] as const) {
            const up = await keydown(textarea(), "ArrowUp", { [modifier]: true });
            expect(up.dispatched).toBe(true);
            expect(value()).toBe("");
        }
        await arrow("ArrowUp");
        expect(value()).toBe("sent");
        const down = await keydown(textarea(), "ArrowDown", { shiftKey: true });
        expect(down.dispatched).toBe(true);
        expect(value()).toBe("sent");
    });

    test("Up with nothing sent yet leaves the field empty", async () => {
        await renderWithSends();
        await arrow("ArrowUp");
        expect(value()).toBe("");
    });

    test("editing a recalled message ends the walk and keeps the edit", async () => {
        await renderWithSends();
        await sendText("first");
        await sendText("second");
        await arrow("ArrowUp");
        await typeInComposer(rendered!.container, "second, edited");
        const up = await arrow("ArrowUp");
        expect(up.dispatched).toBe(true);
        expect(value()).toBe("second, edited");
        const down = await arrow("ArrowDown");
        expect(down.dispatched).toBe(true);
        expect(value()).toBe("second, edited");
    });

    test("completing a recalled command from the palette ends the walk", async () => {
        await renderWithSends();
        await sendText("hello");
        await sendText("/status");
        await arrow("ArrowUp");
        expect(value()).toBe("/status");
        await keydown(textarea(), "Tab");
        const completed = value();
        expect(completed.trim()).toBe("/status");
        const up = await arrow("ArrowUp");
        expect(up.dispatched).toBe(true);
        expect(value()).toBe(completed);
    });

    test("sending a recalled message sends it again", async () => {
        const send = await renderWithSends();
        await sendText("deploy again");
        await arrow("ArrowUp");
        await pressEnter(rendered!.container);
        expect(send).toHaveBeenLastCalledWith("deploy again", "c1");
        expect(send).toHaveBeenCalledTimes(2);
        expect(value()).toBe("");
    });

    test("each conversation recalls only its own sends", async () => {
        await renderWithSends();
        await sendText("for one");
        await select("c2");
        await arrow("ArrowUp");
        expect(value()).toBe("");
        await sendText("for two");
        await select("c1");
        await arrow("ArrowUp");
        expect(value()).toBe("for one");
        await arrow("ArrowUp");
        expect(value()).toBe("for one");
    });

    test("leaving mid-walk does not save the recalled message as the draft", async () => {
        await renderWithSends();
        await sendText("sent line");
        await arrow("ArrowUp");
        expect(value()).toBe("sent line");
        await select("c2");
        await select("c1");
        expect(value()).toBe("");
    });

    test("a message that failed to queue is not recorded", async () => {
        const send = await renderWithSends();
        send.mockResolvedValueOnce(false);
        await sendText("not queued");
        // The failed text stays in the field; clear it and try to recall.
        await typeInComposer(rendered!.container, "");
        await arrow("ArrowUp");
        expect(value()).toBe("");
    });

    test("the palette keeps its arrow keys, and a recalled command doesn't trap the walk", async () => {
        await renderWithSends();
        await sendText("/status");
        await sendText("hello");

        // Typing a command opens the palette; Up/Down move its highlight, not history.
        await typeInComposer(rendered!.container, "/");
        await arrow("ArrowDown");
        expect(textarea().getAttribute("aria-activedescendant")).toBeTruthy();
        expect(value()).toBe("/");
        await typeInComposer(rendered!.container, "");

        // Walking onto "/status" opens the palette, but the walk still owns the arrows.
        await arrow("ArrowUp");
        await arrow("ArrowUp");
        expect(value()).toBe("/status");
        expect(textarea().getAttribute("aria-expanded")).toBe("true");
        await arrow("ArrowDown");
        expect(value()).toBe("hello");
        expect(textarea().getAttribute("aria-activedescendant")).toBeNull();
    });
});

describe("attachment composer", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("opens the picker, dispatches files, and resets it so the same file can be selected again", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) throw new Error("Missing file input");
        const clickInput = jest.spyOn(input, "click");

        await act(async () => button(rendered!.container, "Attach a file").click());

        expect(clickInput).toHaveBeenCalledTimes(1);
        expect(input.multiple).toBe(true);
        expect(button(rendered.container, "Attach a file").getAttribute("aria-disabled")).toBeNull();
        // Mic button renamed to "Record voice message"; in jsdom (no MediaRecorder) the
        // capability guard keeps it aria-disabled.
        expect(button(rendered.container, "Record voice message").getAttribute("aria-disabled")).toBe("true");

        const file = new File(["same"], "same.txt", { type: "text/plain" });
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        Object.defineProperty(input, "value", { configurable: true, writable: true, value: "selected" });

        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
        expect(input.value).toBe("");
        input.value = "selected";
        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

        expect(stageFiles).toHaveBeenNthCalledWith(1, [file]);
        expect(stageFiles).toHaveBeenNthCalledWith(2, [file]);
        expect(input.value).toBe("");
    });

    it("accepts file drops, prevents browser navigation, and clears the overlay", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const room = rendered.container.querySelector<HTMLElement>(".mj_ChatView");
        if (!room) throw new Error("Missing conversation pane");
        const file = new File(["drop"], "drop.txt", { type: "text/plain" });
        const dragOver = fileDragEvent("dragover", file);

        await act(async () => room.dispatchEvent(dragOver));
        expect(dragOver.defaultPrevented).toBe(true);
        expect(rendered!.container.textContent).toContain("Drop files to attach");

        const drop = fileDragEvent("drop", file);
        await act(async () => room.dispatchEvent(drop));

        expect(drop.defaultPrevented).toBe(true);
        expect(stageFiles).toHaveBeenCalledWith([file]);
        expect(rendered.container.textContent).not.toContain("Drop files to attach");
    });

    it("shows the overlay only for file drags and keeps it active over child elements", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const room = rendered.container.querySelector<HTMLElement>(".mj_ChatView");
        const child = rendered.container.querySelector<HTMLElement>(".mj_ChatView_body");
        if (!room || !child) throw new Error("Missing conversation pane");

        const textDrag = new Event("dragover", { bubbles: true, cancelable: true });
        Object.defineProperty(textDrag, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
        await act(async () => room.dispatchEvent(textDrag));
        expect(textDrag.defaultPrevented).toBe(false);
        expect(rendered!.container.textContent).not.toContain("Drop files to attach");

        const file = new File(["drag"], "drag.txt", { type: "text/plain" });
        await act(async () => room.dispatchEvent(fileDragEvent("dragover", file)));
        const overChild = new MouseEvent("dragleave", { bubbles: true, relatedTarget: child });
        await act(async () => room.dispatchEvent(overChild));
        expect(rendered!.container.textContent).toContain("Drop files to attach");

        await act(async () => room.dispatchEvent(new Event("dragend", { bubbles: true })));
        expect(rendered.container.textContent).not.toContain("Drop files to attach");

        await act(async () => room.dispatchEvent(fileDragEvent("dragover", file)));
        const leavePane = new MouseEvent("dragleave", { bubbles: true, relatedTarget: document.body });
        await act(async () => room.dispatchEvent(leavePane));
        expect(rendered.container.textContent).not.toContain("Drop files to attach");
    });

    it("dispatches pasted clipboard files", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const textarea = rendered.container.querySelector<HTMLTextAreaElement>("textarea");
        if (!textarea) throw new Error("Missing composer textarea");
        const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { files: [screenshot] } });

        await act(async () => textarea.dispatchEvent(paste));

        expect(stageFiles).toHaveBeenCalledWith([screenshot]);
    });

    it("composer paste is consumed and does not bubble to a document-level listener", async () => {
        // Regression: a trusted paste stages once in the composer, which mounts the upload
        // modal whose useEffect registers a document-level paste listener. React 19 flushes
        // that effect synchronously inside the trusted event, so without stopPropagation the
        // SAME paste reaches the new listener and stages the file a second time ("1 of 2" for a
        // single paste). The composer must stopPropagation so the event never reaches document.
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles").mockImplementation(() => undefined);
        rendered = await renderClient(client);
        const textarea = rendered.container.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input");
        if (!textarea) throw new Error("Missing composer textarea");
        const documentPaste = jest.fn();
        document.addEventListener("paste", documentPaste);
        try {
            const screenshot = new File(["image"], "screenshot.png", { type: "image/png" });
            const paste = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(paste, "clipboardData", { value: { files: [screenshot] } });
            await act(async () => textarea.dispatchEvent(paste));
            expect(stageFiles).toHaveBeenCalledTimes(1);
            expect(documentPaste).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener("paste", documentPaste);
        }
    });

    it("puts pasted files in the tray above the field, and removes one with its button", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        const textarea = rendered.container.querySelector<HTMLTextAreaElement>("textarea")!;
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        const files = [
            new File(["image"], "screenshot.png", { type: "image/png" }),
            new File(["notes"], "notes.txt", { type: "text/plain" }),
        ];
        Object.defineProperty(paste, "clipboardData", { value: { files } });

        await act(async () => textarea.dispatchEvent(paste));

        const tray = rendered.container.querySelector(".mj_Composer .mj_AttachmentTray")!;
        expect(tray.getAttribute("aria-label")).toBe("Attachments");
        const chips = [...tray.querySelectorAll('[role="listitem"]')];
        expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
            "Image attachment, screenshot.png, 5 B",
            "File attachment, notes.txt, 5 B",
        ]);
        // The tray alone is something to send.
        expect(button(rendered.container, "Send message").disabled).toBe(false);

        await act(async () => button(rendered!.container, "Remove screenshot.png").click());
        expect(client.getSnapshot().composerAttachments.c1.map((item) => item.file.name)).toEqual(["notes.txt"]);
        // The button left with its chip; focus stays in the composer rather than falling to the page.
        expect(document.activeElement).toBe(textarea);
    });

    it("sends the tray with the typed text as one turn, clearing the field", async () => {
        const app = await renderComposerApp(["c1"], signedInClient());
        const { container, client } = app;
        rendered = app;
        const sendStagedFiles = jest
            .spyOn(client, "sendStagedFiles")
            .mockResolvedValue({ outcome: "sent", captionDelivered: true });
        await act(async () => client.stageFiles([new File(["x"], "notes.txt", { type: "text/plain" })]));

        await typeInComposer(container, "please read this");
        await pressEnter(container);

        expect(sendStagedFiles).toHaveBeenCalledWith("c1", "please read this");
        expect(composerValue(container)).toBe("");
    });

    it("puts the text back when it didn't go out with the files", async () => {
        const app = await renderComposerApp(["c1"], signedInClient());
        const { container, client } = app;
        rendered = app;
        jest.spyOn(client, "sendStagedFiles").mockResolvedValue({ outcome: "failed", captionDelivered: false });
        await act(async () => client.stageFiles([new File(["x"], "notes.txt", { type: "text/plain" })]));

        await typeInComposer(container, "please read this");
        await pressEnter(container);

        expect(composerValue(container)).toBe("please read this");
    });

    it("shows upload progress, and a failed file's reason with a retry that sends again", async () => {
        const client = signedInClient();
        const file = (name: string): File => new File(["x"], name, { type: "text/plain" });
        internals(client).state = {
            ...client.getSnapshot(),
            composerAttachments: {
                c1: [
                    { id: "a", file: file("a.txt"), state: "uploading", progress: 0.42 },
                    { id: "b", file: file("b.txt"), state: "queued" },
                ],
            },
        };
        rendered = await renderClient(client);

        const chips = [...rendered.container.querySelectorAll(".mj_StagedAttachment")];
        expect(chips[0].getAttribute("aria-label")).toBe("File attachment, a.txt, 1 B, uploading, 42 percent");
        expect(chips[0].querySelector<HTMLElement>(".mj_StagedAttachment_progressFill")!.style.width).toBe("42%");
        expect(chips[1].getAttribute("aria-label")).toContain("waiting to upload");
        // Nothing in a send in flight can be removed, and the send waits for it.
        expect(rendered.container.querySelector('[aria-label="Remove a.txt"]')).toBeNull();
        expect(button(rendered.container, "Send message").disabled).toBe(true);

        const sendStagedFiles = jest
            .spyOn(client, "sendStagedFiles")
            .mockResolvedValue({ outcome: "sent", captionDelivered: false });
        await act(async () =>
            internals(client).patch({
                composerAttachments: {
                    c1: [
                        { id: "a", file: file("a.txt"), state: "failed", error: "File too large." },
                        { id: "b", file: file("b.txt"), state: "staged" },
                    ],
                },
            }),
        );
        expect(rendered.container.querySelector(".mj_StagedAttachment_failed")?.textContent).toContain(
            "File too large.",
        );
        expect(rendered.container.querySelector('.mj_AttachmentTray_status[role="status"]')?.textContent).toBe(
            "a.txt was not sent: File too large.",
        );
        await act(async () => button(rendered!.container, "Retry sending a.txt").click());
        expect(sendStagedFiles).toHaveBeenCalledWith("c1", "");
    });

    it("shows a failed image as a named chip with its reason instead of a bare thumbnail", async () => {
        const client = signedInClient();
        const createObjectURL = jest.fn(() => "blob:preview");
        const revokeObjectURL = jest.fn();
        Object.assign(URL, { createObjectURL, revokeObjectURL });
        const image = new File(["image"], "photo.png", { type: "image/png" });
        internals(client).state = {
            ...client.getSnapshot(),
            composerAttachments: { c1: [{ id: "a", file: image, state: "staged" }] },
        };
        try {
            rendered = await renderClient(client);
            expect(rendered.container.querySelector(".mj_StagedAttachment_thumb")?.getAttribute("src")).toBe(
                "blob:preview",
            );

            await act(async () =>
                internals(client).patch({
                    composerAttachments: { c1: [{ id: "a", file: image, state: "failed", error: "Server busy." }] },
                }),
            );
            const chip = rendered.container.querySelector(".mj_StagedAttachment_failed")!;
            expect(chip.querySelector(".mj_StagedAttachment_thumb")).toBeNull();
            expect(chip.textContent).toContain("photo.png");
            expect(chip.textContent).toContain("Server busy.");
            expect(chip.getAttribute("aria-label")).toContain("Image attachment, photo.png");

            const { root, container } = rendered;
            await act(async () => root.unmount());
            container.remove();
            rendered = undefined;
            expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
        } finally {
            delete (URL as { createObjectURL?: unknown }).createObjectURL;
            delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
        }
    });

    it("holds the send while the tray has a file that can never upload", async () => {
        const client = signedInClient();
        const oversized = new File(["x"], "huge.bin", { type: "application/octet-stream" });
        Object.defineProperty(oversized, "size", { value: BROWSER_MEMORY_SAFETY_MAX_BYTES + 1 });
        rendered = await renderClient(client);
        const sendStagedFiles = jest.spyOn(client, "sendStagedFiles");

        await act(async () => client.stageFiles([oversized]));

        const chip = rendered.container.querySelector(".mj_StagedAttachment_failed")!;
        expect(chip.textContent).toContain("Too large for this browser to upload.");
        expect(chip.querySelector('[aria-label="Retry sending huge.bin"]')).toBeNull();
        expect(button(rendered.container, "Send message").disabled).toBe(true);
        await pressEnter(rendered.container);
        expect(sendStagedFiles).not.toHaveBeenCalled();
    });

    it("renders uploading and sending attachments as chips rather than empty text bubbles", async () => {
        const client = signedInClient({
            pendingMessages: [
                {
                    localId: "uploading",
                    convoId: "c1",
                    body: "",
                    createdAt: 1,
                    kind: "image",
                    filename: "photo.png",
                    attachState: "uploading",
                },
                {
                    localId: "sending",
                    convoId: "c1",
                    body: "",
                    createdAt: 2,
                    kind: "file",
                    filename: "notes.txt",
                    attachState: "sending",
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_AttachmentChip_uploading")?.textContent).toContain("Uploading…");
        expect(rendered.container.querySelector(".mj_AttachmentChip_sending")?.textContent).toContain("Sending…");
        expect(rendered.container.querySelector(".mj_EventTile_sending")).toBeNull();
        expect(rendered.container.querySelector(".mj_MessageText")).toBeNull();
    });

    it("renders pending messages in timestamp order among journal events", async () => {
        const client = signedInClient({
            events: [
                {
                    kind: "journal",
                    seq: 1,
                    convo_id: "c1",
                    ts: 100,
                    sender: "agent:dev",
                    type: "text",
                    payload: { body: "first event" },
                },
                {
                    kind: "journal",
                    seq: 2,
                    convo_id: "c1",
                    ts: 300,
                    sender: "agent:dev",
                    type: "text",
                    payload: { body: "last event" },
                },
            ],
            pendingMessages: [
                { localId: "pending-late", convoId: "c1", body: "pending late", createdAt: 250 },
                { localId: "pending-early", convoId: "c1", body: "pending early", createdAt: 200 },
            ],
        });
        rendered = await renderClient(client);

        expect(
            [...rendered.container.querySelectorAll(".mj_EventTile_content")].map((item) => item.textContent),
        ).toEqual(["first event", "pending early", "pending late", "last event"]);
    });

    it("renders an echoed file as the inline media tile", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "media-1", filename: "report.pdf", size: 12 },
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_File")?.textContent).toContain("report.pdf");
        expect(rendered.container.querySelector(".mj_AttachmentChip")).toBeNull();
    });

    it("shows the file name from the `name` key that bridge and app senders emit", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: "bin-n", name: "build.log", content_type: "application/octet-stream" },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "agent:1",
                    type: "file",
                    // No content type: the viewer kind must come from the `name` extension.
                    payload: { blob_ref: "pdf-n", name: "runbook.pdf" },
                },
            ],
        });
        rendered = await renderClient(client);

        const tiles = [...rendered.container.querySelectorAll("[data-event-id] .mj_File")];
        expect(tiles.map((tile) => tile.textContent)).toEqual([
            expect.stringContaining("build.log"),
            expect.stringContaining("runbook.pdf"),
        ]);
        expect(tiles[0].classList.contains("mj_File_preview")).toBe(false);
        expect(tiles[1].classList.contains("mj_File_preview")).toBe(true);
    });

    it("plays an audio attachment in an inline player instead of offering a download", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "file",
                    payload: {
                        blob_ref: "voice-1",
                        filename: "voice-note.m4a",
                        content_type: "audio/mp4",
                        size: 48_000,
                    },
                },
            ],
        });
        const mediaUrl = jest.spyOn(client, "mediaUrl").mockResolvedValue("blob:https://journal.example/voice-1");
        const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const audio = rendered.container.querySelector<HTMLAudioElement>("[data-event-id] audio");
        expect(audio).not.toBeNull();
        expect(audio?.controls).toBe(true);
        expect(audio?.getAttribute("src")).toBe("blob:https://journal.example/voice-1");
        expect(mediaUrl).toHaveBeenCalledWith("voice-1");
        expect(rendered.container.querySelector(".mj_Audio")?.textContent).toContain("voice-note.m4a");
        expect(rendered.container.querySelector("[data-event-id] a.mj_File")).toBeNull();
        // Loaded by scrolling into view, not by a click: it must not start playing on its own.
        expect(play).not.toHaveBeenCalled();
        play.mockRestore();
    });

    it("loads a small audio attachment only once its row scrolls into view", async () => {
        const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
        class FakeObserver {
            public disconnected = false;
            public constructor(public callback: IntersectionObserverCallback) {
                observers.push(this);
            }
            public observe(): void {}
            public disconnect(): void {
                this.disconnected = true;
            }
        }
        (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
        try {
            const client = signedInClient({
                events: [
                    {
                        seq: 1,
                        convo_id: "c1",
                        ts: 1,
                        sender: "user:2",
                        type: "file",
                        payload: { blob_ref: "voice-2", filename: "later.m4a", content_type: "audio/mp4", size: 1000 },
                    },
                ],
            });
            const mediaUrl = jest.spyOn(client, "mediaUrl").mockResolvedValue("blob:https://journal.example/voice-2");
            const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
            rendered = await renderClient(client);

            // Off screen: nothing fetched yet, the row is a plain Play button.
            expect(mediaUrl).not.toHaveBeenCalled();
            expect(rendered.container.querySelector("[data-event-id] audio")).toBeNull();
            const observer = observers.at(-1)!;
            await act(async () => {
                observer.callback(
                    [{ isIntersecting: true } as IntersectionObserverEntry],
                    observer as unknown as IntersectionObserver,
                );
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(mediaUrl).toHaveBeenCalledWith("voice-2");
            expect(observer.disconnected).toBe(true);
            expect(rendered.container.querySelector("[data-event-id] audio")).not.toBeNull();
            expect(play).not.toHaveBeenCalled();
            play.mockRestore();
        } finally {
            delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
        }
    });

    it("keeps the audio row with a Retry when the fetch fails for a transient reason", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "voice-3", filename: "flaky.m4a", content_type: "audio/mp4", size: 1000 },
                },
            ],
        });
        const mediaUrl = jest
            .spyOn(client, "mediaUrl")
            .mockRejectedValueOnce(new JournalApiError("Service unavailable", 503))
            .mockResolvedValue("blob:https://journal.example/voice-3");
        rendered = await renderClient(client);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(rendered.container.querySelector(".mj_Audio")?.textContent).toContain("flaky.m4a");
        expect(rendered.container.querySelector("[data-event-id] audio")).toBeNull();
        await act(async () => button(rendered!.container, "Retry loading flaky.m4a").click());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mediaUrl).toHaveBeenCalledTimes(2);
        expect(rendered.container.querySelector("[data-event-id] audio")?.getAttribute("src")).toBe(
            "blob:https://journal.example/voice-3",
        );
    });

    it("waits for a click before fetching a large audio attachment", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "file",
                    payload: {
                        blob_ref: "talk-1",
                        filename: "talk.mp3",
                        content_type: "audio/mpeg",
                        size: 200 * 1024 * 1024,
                    },
                },
            ],
        });
        const mediaUrl = jest.spyOn(client, "mediaUrl").mockResolvedValue("blob:https://journal.example/talk-1");
        const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        rendered = await renderClient(client);

        expect(mediaUrl).not.toHaveBeenCalled();
        expect(rendered.container.querySelector("[data-event-id] audio")).toBeNull();
        await act(async () => button(rendered!.container, "Play talk.mp3").click());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mediaUrl).toHaveBeenCalledWith("talk-1");
        expect(rendered.container.querySelector("[data-event-id] audio")?.getAttribute("src")).toBe(
            "blob:https://journal.example/talk-1",
        );
        // The click asked to play, so playback starts once the blob is in.
        expect(play).toHaveBeenCalledTimes(1);
        play.mockRestore();
    });

    it("shows a reaped image or file as expired without fetching it", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "image",
                    payload: { blob_ref: "img-gone", content_type: "image/png", expired: true },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: null, filename: "report.pdf", size: 12_000, expired: true },
                },
            ],
        });
        const mediaUrl = jest.spyOn(client, "mediaUrl");
        rendered = await renderClient(client);

        const image = rendered.container.querySelector('[data-event-id="1"] .mj_MediaExpired');
        expect(image?.textContent).toContain("Image expired");
        const chip = rendered.container.querySelector('[data-event-id="2"] .mj_File_expired');
        expect(chip?.textContent).toContain("report.pdf");
        expect(chip?.textContent).toContain("Expired");
        expect(chip?.tagName).not.toBe("BUTTON");
        expect(chip?.getAttribute("aria-label")).toBe("File attachment: report.pdf, expired");
        // The size gives way to the expired label, as on the native apps.
        expect(rendered.container.querySelector('[data-event-id="2"] .mj_FileSize')).toBeNull();
        expect(mediaUrl).not.toHaveBeenCalled();
    });

    it("names the expired chip and the inline audio player from the `name` key", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: null, name: "notes.txt", size: 12_000, expired: true },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "voice-name", name: "memo.m4a", content_type: "audio/mp4", size: 1000 },
                },
            ],
        });
        jest.spyOn(client, "mediaUrl").mockResolvedValue("blob:https://journal.example/voice-name");
        rendered = await renderClient(client);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const chip = rendered.container.querySelector('[data-event-id="1"] .mj_File_expired');
        expect(chip?.textContent).toContain("notes.txt");
        expect(chip?.getAttribute("aria-label")).toBe("File attachment: notes.txt, expired");
        expect(rendered.container.querySelector('[data-event-id="2"] .mj_Audio')?.textContent).toContain("memo.m4a");
    });

    it("flips an image or file to expired when the server answers 404", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "image",
                    payload: { blob_ref: "img-404", content_type: "image/png" },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: "bin-404", filename: "dump.bin", size: 10 },
                },
            ],
        });
        jest.spyOn(client, "mediaUrl").mockRejectedValue(new JournalApiError("not found", 404));
        rendered = await renderClient(client);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(rendered.container.querySelector('[data-event-id="1"] .mj_MediaExpired')?.textContent).toContain(
            "Image expired",
        );
        expect(rendered.container.querySelector('[data-event-id="1"] .mj_Error')).toBeNull();

        const download = rendered.container.querySelector<HTMLButtonElement>('[data-event-id="2"] button.mj_File');
        await act(async () => download?.click());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const chip = rendered.container.querySelector('[data-event-id="2"] .mj_File_expired');
        expect(chip?.textContent).toContain("dump.bin");
        expect(rendered.container.querySelector('[data-event-id="2"] .mj_Error')).toBeNull();
    });

    it("shows an expired item in the media viewer as expired, not as a load error", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "image",
                    payload: { blob_ref: "img-ok", content_type: "image/png" },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: "pdf-404", filename: "spec.pdf", content_type: "application/pdf" },
                },
            ],
        });
        jest.spyOn(client, "mediaUrl").mockImplementation(async (id: string) => {
            if (id === "img-ok") return "blob:https://journal.example/img-ok";
            throw new JournalApiError("not found", 404);
        });
        rendered = await renderClient(client);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const image = rendered.container.querySelector<HTMLImageElement>(".mj_ImageFrame img");
        await act(async () => image?.click());
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(rendered.container.querySelector(".mj_MediaViewer_count")?.textContent).toBe("2 / 2");
        const expired = rendered.container.querySelector(".mj_MediaViewer_expired");
        expect(expired?.textContent).toContain("File expired");
        expect(expired?.textContent).toContain("spec.pdf");
        expect(rendered.container.querySelector(".mj_MediaViewer_retry")).toBeNull();
    });

    it("opens the media viewer when an inline image is clicked, and closes on Escape", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "image",
                    payload: { blob_ref: "img-a", content_type: "image/png" },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: "pdf-a", filename: "spec.pdf", content_type: "application/pdf" },
                },
            ],
        });
        jest.spyOn(client, "mediaUrl").mockResolvedValue("blob:https://journal.example/img-a");
        rendered = await renderClient(client);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // The viewer is not mounted until a media item is clicked.
        expect(rendered.container.querySelector(".mj_MediaViewer_scrim")).toBeNull();
        const image = rendered.container.querySelector<HTMLImageElement>(".mj_ImageFrame img");
        expect(image).not.toBeNull();
        await act(async () => image?.click());
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // Viewer opens; corpus = both media events (image + pdf), so the index reads "1 / 2".
        expect(rendered.container.querySelector(".mj_MediaViewer_scrim")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_MediaViewer_count")?.textContent).toBe("1 / 2");

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(rendered.container.querySelector(".mj_MediaViewer_scrim")).toBeNull();
    });

    it("renders a renderable file (pdf) as a preview button, a non-renderable file as a download chip", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: "pdf-b", filename: "runbook.pdf", content_type: "application/pdf" },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "agent:1",
                    type: "file",
                    payload: { blob_ref: "bin-b", filename: "blob.bin" },
                },
            ],
        });
        rendered = await renderClient(client);

        const pdfTile = rendered.container.querySelector("[data-event-id] .mj_File_preview");
        expect(pdfTile?.tagName).toBe("BUTTON");
        expect(pdfTile?.textContent).toContain("runbook.pdf");
        const binTile = [...rendered.container.querySelectorAll("[data-event-id] .mj_File")].find(
            (tile) => !tile.classList.contains("mj_File_preview"),
        );
        expect(binTile?.textContent).toContain("blob.bin");
    });

    it("reserves an aspect-ratio box for an image event that carries bridge dims", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "image",
                    payload: { blob_ref: "img-1", content_type: "image/png", dims: { width: 1200, height: 800 } },
                },
            ],
        });
        jest.spyOn(client, "mediaUrl").mockResolvedValue("data:image/png;base64,AAAA");
        rendered = await renderClient(client);

        const frame = rendered.container.querySelector<HTMLElement>(".mj_ImageFrame");
        expect(frame).not.toBeNull();
        expect(frame?.classList.contains("mj_ImageFrame_sized")).toBe(true);
        // The reserved box is the inline aspect-ratio + width; this is what holds height
        // before the blob decodes so the thread doesn't reflow. The width is pre-shrunk so the
        // 520px max-height cap preserves the ratio (1200×800 → 780×520), since a non-replaced
        // <div> won't back-shrink its width on its own.
        expect(frame?.style.aspectRatio).toBe("1200 / 800");
        expect(frame?.style.width).toBe("780px");
        expect(frame?.getAttribute("data-dims")).toBe("1200x800");
    });

    it("does NOT reserve a box for an image event without dims (fluid fallback, §6)", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "image",
                    payload: { blob_ref: "img-2", content_type: "image/png" },
                },
            ],
        });
        jest.spyOn(client, "mediaUrl").mockResolvedValue("data:image/png;base64,AAAA");
        rendered = await renderClient(client);

        const frame = rendered.container.querySelector<HTMLElement>(".mj_ImageFrame");
        expect(frame).not.toBeNull();
        expect(frame?.classList.contains("mj_ImageFrame_sized")).toBe(false);
        expect(frame?.style.aspectRatio).toBe("");
        expect(frame?.getAttribute("data-dims")).toBeNull();
    });

    it("picks a file-tile icon from the MIME bucket, generic when absent (§6)", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "pdf-1", filename: "runbook.pdf", content_type: "application/pdf" },
                },
                {
                    seq: 2,
                    convo_id: "c1",
                    ts: 2,
                    sender: "user:2",
                    type: "file",
                    payload: { blob_ref: "bin-1", filename: "blob.bin" },
                },
            ],
        });
        rendered = await renderClient(client);

        const tiles = [...rendered.container.querySelectorAll<HTMLElement>("[data-event-id] .mj_File")];
        expect(tiles).toHaveLength(2);
        // Both render an icon glyph + name; the icon SVG distinguishes the bucket. We assert
        // an icon is present per tile (mj_FileIcon) and the two SVGs differ (pdf vs generic).
        const icons = tiles.map((tile) => tile.querySelector<SVGElement>(".mj_FileIcon"));
        expect(icons.every(Boolean)).toBe(true);
        expect(icons[0]?.innerHTML).not.toBe(icons[1]?.innerHTML);
        expect(tiles[0].textContent).toContain("runbook.pdf");
        expect(tiles[1].textContent).toContain("blob.bin");
    });

    it("renders the caption under file tiles and pending chips, and prefers errorMessage on error chips", async () => {
        const client = signedInClient({
            events: [
                {
                    seq: 1,
                    convo_id: "c1",
                    ts: 1,
                    sender: "user:alice",
                    type: "file",
                    payload: {
                        blob_ref: "m1",
                        filename: "notes.txt",
                        size: 10,
                        caption: "read this first",
                    },
                },
            ],
            pendingMessages: [
                {
                    localId: "p1",
                    convoId: "c1",
                    body: "",
                    createdAt: 2,
                    kind: "image",
                    filename: "shot.png",
                    size: 5,
                    contentType: "image/png",
                    blobRef: null,
                    attachState: "error",
                    errorKind: "upload_failed",
                    canRetry: true,
                    caption: "look at this",
                    errorMessage: "Conversation was archived in another tab — unarchive to retry.",
                },
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.textContent).toContain("read this first");
        expect(rendered.container.textContent).toContain("look at this");
        expect(rendered.container.textContent).toContain("unarchive to retry");
    });

    it("shows Retry only when canRetry is true and dispatches the retry", async () => {
        const errorMessage: PendingMessage = {
            localId: "failed",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "failed.txt",
            attachState: "error",
            errorKind: "upload_failed",
            canRetry: false,
        };
        const client = signedInClient({ pendingMessages: [errorMessage] });
        const retry = jest.spyOn(client, "retryAttachment").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        expect(rendered.container.querySelector(".mj_AttachmentChip_error")?.textContent).toContain(
            "Couldn't upload attachment.",
        );
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Retry")).toBe(
            false,
        );

        await act(async () => rendered?.root.unmount());
        rendered.container.remove();
        rendered = undefined;

        const retryableClient = signedInClient({ pendingMessages: [{ ...errorMessage, canRetry: true }] });
        const retryable = jest.spyOn(retryableClient, "retryAttachment").mockResolvedValue(undefined);
        rendered = await renderClient(retryableClient);
        const retryButton = [...rendered.container.querySelectorAll("button")].find(
            (item) => item.textContent === "Retry",
        );
        if (!retryButton) throw new Error("Missing Retry button");
        await act(async () => retryButton.click());

        expect(retry).not.toHaveBeenCalled();
        expect(retryable).toHaveBeenCalledWith("failed");
    });

    it("shows the original terminal Electron upload error without Retry", async () => {
        const client = signedInClient({
            pendingMessages: [
                {
                    localId: "desktop-failed",
                    convoId: "c1",
                    body: "",
                    createdAt: 1,
                    kind: "file",
                    filename: "desktop.bin",
                    attachState: "error",
                    errorKind: "electron_binary_unsupported",
                    errorMessage: "Attachments aren't supported in this desktop package.",
                    canRetry: false,
                },
            ],
        });

        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_AttachmentChip_error")?.textContent).toContain(
            "Attachments aren't supported in this desktop package.",
        );
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Retry")).toBe(
            false,
        );
    });

    it("Dismiss durably removes the attachment row and its retained bytes", async () => {
        const message: PendingMessage = {
            localId: "failed",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "file",
            filename: "failed.txt",
            attachState: "error",
            errorKind: "upload_failed",
            canRetry: true,
        };
        const rows = new Map([[message.localId, message]]);
        const database = {
            deleteOutboxRow: jest.fn(async (localId: string) => {
                rows.delete(localId);
            }),
            events: jest.fn().mockResolvedValue([]),
            outbox: jest.fn(async () => [...rows.values()]),
        };
        const client = signedInClient({ pendingMessages: [message] });
        internals(client).database = database;
        internals(client).pendingFiles.set(message.localId, new File(["retry"], message.filename!));
        rendered = await renderClient(client);
        const dismiss = [...rendered.container.querySelectorAll("button")].find(
            (item) => item.textContent === "Dismiss",
        );
        if (!dismiss) throw new Error("Missing Dismiss button");

        await act(async () => {
            dismiss.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(database.deleteOutboxRow).toHaveBeenCalledWith(message.localId);
        expect(rows.has(message.localId)).toBe(false);
        expect(internals(client).pendingFiles.has(message.localId)).toBe(false);
        expect(rendered.container.querySelector(".mj_AttachmentChip")).toBeNull();
    });
});

describe("EventRow context menu and source sheet", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    test("right-click a text EventRow opens a menu with Copy, Copy as Markdown, and View source", async () => {
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        await openRowMenu(rendered.container, 5);
        const items = [...rendered.container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map(
            (node) => node.textContent,
        );
        expect(items).toEqual(["Copy", "Copy as Markdown", "View source"]);
    });

    test("Copy as Markdown copies the raw body; Copy strips markdown", async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        rendered = await renderAppWithEvents([textEvent(5, "**bold** and `code`")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "Copy as Markdown");
        expect(writeText).toHaveBeenLastCalledWith("**bold** and `code`");
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "Copy");
        expect(writeText).toHaveBeenLastCalledWith("bold and code");
    });

    test("a non-text event hides Copy, keeps View source", async () => {
        rendered = await renderAppWithEvents([
            { seq: 6, convo_id: "c1", ts: 1, sender: "agent", type: "diff", payload: {} },
        ]);
        await openRowMenu(rendered.container, 6);
        expect(
            [...rendered.container.querySelectorAll('.mj_EventRowMenu [role="menuitem"]')].map(
                (node) => node.textContent,
            ),
        ).toEqual(["View source"]);
    });

    test("a ToolStream / pending placeholder row has no menu on right-click", async () => {
        rendered = await renderAppWithToolStream();
        const row = rendered.container.querySelector(".mj_LiveTool")?.closest("li");
        if (!row) throw new Error("Missing tool stream row");
        await rightClick(row);
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();
    });

    test("Copy on a text row calls the clipboard with the body", async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        rendered = await renderAppWithEvents([textEvent(5, "hello")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "Copy");
        expect(writeText).toHaveBeenCalledWith("hello");
    });

    test("View source shows the event DTO JSON + meta grid; Copy JSON, Close, Esc, and backdrop all close", async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        const pre = rendered.container.querySelector(".mj_EventSource_json");
        expect(pre?.textContent).toContain('"seq": 5');
        expect(pre?.textContent).toContain('"body": "hi"');
        // §10.8: scalar fields lifted into a meta grid + a size in the footer.
        const metaLabels = [...rendered.container.querySelectorAll(".mj_EventSource_metaLabel")].map(
            (node) => node.textContent,
        );
        expect(metaLabels).toEqual(["seq", "sender", "timestamp", "convo"]);
        expect(rendered.container.querySelector(".mj_EventSource_note")?.textContent).toMatch(/Read-only · \d+ bytes/);
        await clickButton(rendered.container, "Copy JSON");
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"seq": 5'));
        await clickButton(rendered.container, "Close");
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();
        expect(document.activeElement).toBe(rendered.container.querySelector('[data-event-id="5"]'));

        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();

        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        await act(async () => {
            (rendered?.container.querySelector(".mj_EventSource_scrim") as HTMLElement).click();
        });
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();
    });

    test("View source traps Tab and Shift+Tab within the sheet", async () => {
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        const sheet = rendered.container.querySelector(".mj_EventSource");
        const buttons = [...(sheet?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        // DOM order: header ✕ close (icon only) · footer Close · footer Copy JSON.
        expect(buttons.map((candidate) => candidate.textContent)).toEqual(["", "Close", "Copy JSON"]);
        // Initial focus is the primary Copy JSON action (the last button).
        expect(document.activeElement).toBe(buttons[2]);

        const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        await act(async () => document.dispatchEvent(forward));
        expect(forward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(buttons[0]);

        const backward = new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        await act(async () => document.dispatchEvent(backward));
        expect(backward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(buttons[2]);
    });

    test("long-press opens the menu; a scroll during the press cancels it", async () => {
        jest.useFakeTimers();
        rendered = await renderAppWithEvents([textEvent(5, "hi")]);
        const row = rendered.container.querySelector('[data-event-id="5"]') as HTMLElement;
        await touchPress(row);
        await act(async () => {
            document.dispatchEvent(new Event("scroll", { bubbles: true }));
            jest.advanceTimersByTime(500);
        });
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();
        await touchPress(row);
        await act(async () => jest.advanceTimersByTime(500));
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
    });

    test("a long-press timer firing after the row unmounts does not poison the next conversation", async () => {
        jest.useFakeTimers();
        const result = await renderAppWithEvents(
            [textEvent(5, "hi"), { ...textEvent(6, "new conversation"), convo_id: "c2" }],
            ["c1", "c2"],
        );
        rendered = result;
        const row = rendered.container.querySelector('[data-event-id="5"]') as HTMLElement;
        await touchPress(row, 1);
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        await act(async () => jest.advanceTimersByTime(500));
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();

        const newRow = rendered.container.querySelector('[data-event-id="6"]') as HTMLElement;
        await touchPress(newRow, 2);
        await act(async () => jest.advanceTimersByTime(500));
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
    });

    test("switching conversations closes an OPEN MENU (menu still open, not via View source)", async () => {
        const result = await renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
        rendered = result;
        await openRowMenu(rendered.container, 5);
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(rendered.container.querySelector(".mj_EventRowMenu")).toBeNull();
    });

    test("switching conversations closes an open source sheet", async () => {
        const result = await renderAppWithEvents([textEvent(5, "hi")], ["c1", "c2"]);
        rendered = result;
        await openRowMenu(rendered.container, 5);
        await clickMenuItem(rendered.container, "View source");
        expect(rendered.container.querySelector(".mj_EventSource")).not.toBeNull();
        await act(async () => {
            await result.client.selectConversation("c2");
        });
        expect(rendered.container.querySelector(".mj_EventSource")).toBeNull();
    });

    test("long-pressing a prompt button opens the menu without activating the button", async () => {
        jest.useFakeTimers();
        const prompt: JournalEvent = {
            seq: 7,
            convo_id: "c1",
            ts: 1,
            sender: "agent",
            type: "prompt",
            payload: { question: "Choose", options: ["Yes"] },
        };
        const result = await renderAppWithEvents([prompt]);
        rendered = result;
        const sendPromptReply = jest.spyOn(result.client, "sendPromptReply").mockReturnValue(true);
        const option = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "Yes",
        );
        if (!option) throw new Error("Missing prompt option");
        await touchPress(option);
        await act(async () => jest.advanceTimersByTime(500));
        await act(async () => option.click());
        expect(rendered.container.querySelector(".mj_EventRowMenu")).not.toBeNull();
        expect(sendPromptReply).not.toHaveBeenCalled();
    });
});

describe("conversation menu controls", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it("keeps an accessible, keyboard-activatable menu trigger (kebab) on each row", async () => {
        rendered = await renderClient(signedInClient());
        const trigger = button(rendered.container, "Conversation options");
        expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
        // Activating the trigger (as keyboard Enter/Space does) opens the row menu.
        await act(async () => trigger.click());
        expect(menuItem(rendered!.container, "Pin")).toBeTruthy();
        expect(menuItem(rendered!.container, "Archive")).toBeTruthy();
    });

    it("menu shows Pin when unpinned and Unpin when pinned", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Pin")).toBeTruthy();
        expect(menuItem(rendered.container, "Unpin")).toBeFalsy();
        await act(async () => (menuItem(rendered!.container, "Pin") as HTMLElement).click());
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Unpin")).toBeTruthy();
    });

    it("menu shows Add to Favorites when unfavorited and Remove from Favorites when favorited", async () => {
        favoriteStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInClient();
        rendered = await renderClient(client);
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Remove from Favorites")).toBeTruthy();
    });

    it("menu shows Mark as unread (not Mark as read) for a read, non-archived row", async () => {
        rendered = await renderClient(signedInClient());
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Mark as unread")).toBeTruthy();
        expect(menuItem(rendered.container, "Mark as read")).toBeFalsy();
    });

    it("menu shows Mark as read (not Mark as unread) for an override-only unread row, and clicking it clears the override", async () => {
        unreadStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInClient();
        rendered = await renderClient(client);
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Mark as read")).toBeTruthy();
        expect(menuItem(rendered.container, "Mark as unread")).toBeFalsy();
        await act(async () => (menuItem(rendered!.container, "Mark as read") as HTMLElement).click());
        expect(client.getSnapshot().unreadOverrideIds.has(CONVERSATION.id)).toBe(false);
    });

    it("menu offers neither Mark-read nor Mark-unread for an archived row (read affordances are active-only)", async () => {
        archiveStore.write(SESSION, new Set([CONVERSATION.id]));
        rendered = await renderClient(signedInClient());
        await act(async () => tabButton(rendered!.container, "archived").click());
        await openMenu(rendered.container);
        expect(menuItem(rendered.container, "Mark as unread")).toBeFalsy();
        expect(menuItem(rendered.container, "Mark as read")).toBeFalsy();
        expect(menuItem(rendered.container, "Unarchive")).toBeTruthy();
    });

    it("keeps the selected conversation when unfavoriting hides it from the Favorites tab", async () => {
        favoriteStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInClient();
        rendered = await renderClient(client);
        await act(async () => tabButton(rendered!.container, "favorites").click());
        await openMenu(rendered.container);
        await act(async () => (menuItem(rendered!.container, "Remove from Favorites") as HTMLElement).click());

        expect(rendered.container.querySelector('[data-testid="conversation-name"]')).toBeNull();
        expect(client.getSnapshot().selectedConversationId).toBe(CONVERSATION.id);
    });

    it("moves keyboard focus through every menu item with arrow keys and wraps", async () => {
        rendered = await renderClient(signedInClient());
        await openMenu(rendered.container);
        const menu = rendered.container.querySelector<HTMLElement>('[role="menu"]')!;
        const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        expect(items.map((item) => item.textContent?.trim())).toEqual([
            "Pin",
            "Add to Favorites",
            "Mark as unread",
            "Archive",
        ]);
        expect(document.activeElement).toBe(items[0]);

        for (const expected of [...items.slice(1), items[0]]) {
            await act(async () => {
                menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
            });
            expect(document.activeElement).toBe(expected);
        }
        await act(async () => {
            menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        });
        expect(document.activeElement).toBe(items.at(-1));
    });

    it("opens the conversation menu on right-click", async () => {
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]')!;

        await act(async () => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 32 }),
            );
        });

        expect(rendered.container.querySelector('[role="menu"]')).not.toBeNull();
        expect(menuItem(rendered.container, "Pin")).toBeTruthy();
    });

    it("opens the conversation menu after a touch long-press", async () => {
        jest.useFakeTimers();
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]')!;
        const pointerDown = new MouseEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            clientX: 12,
            clientY: 18,
        });
        Object.defineProperty(pointerDown, "pointerType", { value: "touch" });

        await act(async () => {
            row.dispatchEvent(pointerDown);
            jest.advanceTimersByTime(500);
        });

        expect(rendered.container.querySelector('[role="menu"]')).not.toBeNull();
        expect(menuItem(rendered.container, "Pin")).toBeTruthy();
    });
});

describe("conversation row affordances", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("renders pinned rows before unpinned in the active list", async () => {
        const roomA = { ...CONVERSATION, id: "room-a", title: "Room A" };
        const roomB = { ...CONVERSATION, id: "room-b", title: "Room B" };
        pinnedStore.write(SESSION, new Set(["room-b"]));
        rendered = await renderClient(signedInWithRooms([roomA, roomB]));
        const names = [...rendered.container.querySelectorAll('[data-testid="conversation-name"]')].map(
            (element) => element.textContent,
        );
        expect(names[0]).toBe("Room B");
        expect(names[1]).toBe("Room A");
    });

    it("includes the visible last-activity timestamp in the row button's accessible name", async () => {
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]');
        const timestamp = rendered.container.querySelector(".mj_ConversationListTime")?.textContent;
        expect(timestamp).toBeTruthy();
        expect(row?.getAttribute("aria-label")).toContain(`last activity ${timestamp}`);
    });

    it("override-unread row announces marked-unread in the row button's accessible name and renders no numeric badge", async () => {
        unreadStore.write(SESSION, new Set([CONVERSATION.id]));
        rendered = await renderClient(signedInClient());
        const row = rendered.container.querySelector<HTMLButtonElement>('button[aria-label^="Open room"]');
        expect(row?.getAttribute("aria-label")).toContain("marked unread");
        expect(rendered.container.querySelector(".mj_UnreadBadge")).toBeNull();
    });
});

describe("needs-you and New badges in the conversation list and the rail", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    function awaiting(id: string, originConvoId: string, missionId: string | null = null): TrackerItem {
        return {
            id,
            num: 1,
            kind: "question",
            state: "open",
            awaiting: "user",
            title: "Pick one",
            origin_convo_id: originConvoId,
            mission_id: missionId,
        } as TrackerItem;
    }

    function patch(client: MatronJournalClient, update: Partial<ClientState>): void {
        act(() => (client as unknown as { patch(update: Partial<ClientState>): void }).patch(update));
    }

    function row(container: HTMLElement, title: string): HTMLButtonElement {
        const match = container.querySelector<HTMLButtonElement>(`button[aria-label^="Open room ${title},"]`);
        if (!match) throw new Error(`Missing row: ${title}`);
        return match;
    }

    const roomA = { ...CONVERSATION, id: "room-a", title: "Room A" };
    const roomB = { ...CONVERSATION, id: "room-b", title: "Room B" };

    it("counts the items a conversation raised that wait on the user, live as they change", async () => {
        const client = signedInWithRooms([CONVERSATION, roomA, roomB]);
        rendered = await renderClient(client);
        expect(rendered.container.querySelector(".mj_ConversationListBadges .mj_TrackerNeedsYouBadge")).toBeNull();

        patch(client, {
            inboxItems: [
                awaiting("i1", "room-a"),
                awaiting("i2", "room-a"),
                { ...awaiting("i3", "room-b"), awaiting: "agent" },
            ],
        });
        const badge = row(rendered.container, "Room A").querySelector(".mj_TrackerNeedsYouBadge");
        expect(badge?.textContent).toBe("2");
        expect(row(rendered.container, "Room A").getAttribute("aria-label")).toContain("2 items need you");
        expect(row(rendered.container, "Room B").querySelector(".mj_TrackerNeedsYouBadge")).toBeNull();

        // Answering one drops the count on the row without anything else in the list changing.
        patch(client, { inboxItems: [awaiting("i2", "room-a")] });
        expect(row(rendered.container, "Room A").querySelector(".mj_TrackerNeedsYouBadge")?.textContent).toBe("1");
        expect(row(rendered.container, "Room A").getAttribute("aria-label")).toContain("1 item needs you");
    });

    it("marks a session that arrived unasked as New until it is opened", async () => {
        const client = signedInWithRooms([CONVERSATION, roomA, roomB]);
        rendered = await renderClient(client);
        patch(client, { newConversationIds: new Set(["room-a"]) });
        expect(row(rendered.container, "Room A").querySelector(".mj_ConversationListNew")?.textContent).toBe("New");
        expect(row(rendered.container, "Room A").getAttribute("aria-label")).toContain("new session");
        expect(row(rendered.container, "Room B").querySelector(".mj_ConversationListNew")).toBeNull();

        patch(client, { newConversationIds: new Set() });
        expect(row(rendered.container, "Room A").querySelector(".mj_ConversationListNew")).toBeNull();
    });

    it("never shows New on an agent-chat room", async () => {
        const room = { ...CONVERSATION, id: "room-c", title: "🔗 box-a and box-b" };
        const client = signedInWithRooms([CONVERSATION, room]);
        rendered = await renderClient(client);
        patch(client, { newConversationIds: new Set(["room-c"]) });
        expect(rendered.container.querySelector(".mj_ConversationListNew")).toBeNull();
    });

    it("drops New from a session whose parent link landed after it was marked", async () => {
        const child = { ...CONVERSATION, id: "c1:codex:agent-1", title: "Worker", parent_convo_id: "c1" };
        const client = signedInWithRooms([CONVERSATION, child]);
        rendered = await renderClient(client);
        patch(client, { newConversationIds: new Set([child.id]) });
        expect(rendered.container.querySelector(".mj_ConversationListNew")).toBeNull();
    });

    it("badges Projects in the rail with what needs the user across the missions", async () => {
        const client = signedInWithRooms([CONVERSATION]);
        rendered = await renderClient(client);
        const projects = (): HTMLButtonElement =>
            rendered!.container.querySelector<HTMLButtonElement>('[data-nav="projects"]')!;
        expect(projects().querySelector(".mj_NavRail_badge")).toBeNull();

        patch(client, {
            inboxItems: [awaiting("i1", "c1", "m1"), awaiting("i2", "c1", "m2"), awaiting("i3", "c1", null)],
        });
        expect(projects().querySelector(".mj_NavRail_badge")?.textContent).toBe("2");
        expect(projects().getAttribute("aria-label")).toBe("Projects, 2 need you");
    });
});

describe("conversation timestamp midnight invalidation", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;
    let originalTZ: string | undefined;

    beforeEach(() => {
        originalTZ = process.env.TZ;
        process.env.TZ = "UTC";
        jest.useFakeTimers();
        jest.setSystemTime(new Date(2026, 2, 20, 23, 59, 59, 500));
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.useRealTimers();
        if (originalTZ === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTZ;
        }
    });

    it("reclassifies at midnight, re-arms each day, and clears its timer on unmount", async () => {
        const lastTimestamp = Date.now();
        favoriteStore.write(SESSION, new Set([CONVERSATION.id]));
        const client = signedInWithRooms([{ ...CONVERSATION, created_at: lastTimestamp, last_ts: lastTimestamp }]);
        internals(client).state = { ...client.getSnapshot(), selectedConversationId: undefined };
        rendered = await renderClient(client);
        const timestamp = (): string | null =>
            rendered!.container.querySelector(".mj_ConversationListTime")?.textContent ?? null;
        const expectedClock = new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
        }).format(new Date(lastTimestamp));
        const expectedWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
            new Date(lastTimestamp),
        );

        expect(timestamp()).toBe(expectedClock);

        await act(async () => {
            jest.advanceTimersByTime(1_600);
        });

        expect(timestamp()).toBe(expectedWeekday);
        expect(timestamp()).not.toBe(expectedClock);
        expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

        await act(async () => {
            jest.advanceTimersByTime(86_400_000);
        });

        expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

        // Isolate the effect from MatronApp's other timers, then use a tab rerender to re-arm it.
        jest.clearAllTimers();
        const baselineTimerCount = jest.getTimerCount();
        await act(async () => tabButton(rendered!.container, "favorites").click());
        expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);
        await act(async () => rendered?.root.unmount());
        rendered.container.remove();
        rendered = undefined;
        // Drain short app cleanup work; a leaked next-midnight timer would remain queued.
        jest.advanceTimersByTime(1_000);
        expect(jest.getTimerCount()).toBe(baselineTimerCount);
    });

    it("reclassifies when midnight passes between render and effect execution", async () => {
        const lastTimestamp = Date.now();
        const client = signedInWithRooms([{ ...CONVERSATION, created_at: lastTimestamp, last_ts: lastTimestamp }]);
        internals(client).state = { ...client.getSnapshot(), selectedConversationId: undefined };
        const afterMidnight = new Date(2026, 2, 21, 0, 0, 0, 500);
        function CrossMidnightBeforeEffects(): React.ReactElement {
            React.useLayoutEffect(() => {
                jest.setSystemTime(afterMidnight);
            }, []);
            return React.createElement(MatronApp, { client });
        }

        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        rendered = { container, root };
        await act(async () => {
            root.render(React.createElement(CrossMidnightBeforeEffects));
        });

        const expectedWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
            new Date(lastTimestamp),
        );
        expect(container.querySelector(".mj_ConversationListTime")?.textContent).toBe(expectedWeekday);
    });
});

describe("mobile layout", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    function sidebar(container: HTMLElement): HTMLElement {
        const wrapper = container.querySelector<HTMLElement>(".mj_Sidebar_outerWrapper");
        if (!wrapper) throw new Error("Missing sidebar wrapper");
        return wrapper;
    }

    it("shows the sidebar when nothing is selected and the tracker is closed", async () => {
        const client = signedInClient();
        internals(client).state = { ...client.getSnapshot(), selectedConversationId: undefined };
        rendered = await renderClient(client);
        expect(sidebar(rendered.container).classList.contains("mj_Sidebar_mobileHidden")).toBe(false);
    });

    it("hides the sidebar at the mobile breakpoint while the tracker pane is open", async () => {
        // With no conversation selected the tracker pane is the main surface; on a phone it must
        // take the whole width, exactly as a selected conversation does.
        const client = signedInClient();
        internals(client).state = {
            ...client.getSnapshot(),
            selectedConversationId: undefined,
            trackerView: { open: true, view: "inbox" },
        };
        rendered = await renderClient(client);
        expect(rendered.container.querySelector(".mj_TrackerPane")).not.toBeNull();
        expect(sidebar(rendered.container).classList.contains("mj_Sidebar_mobileHidden")).toBe(true);
    });
});

describe("conversation list tabs", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("switches among Active, Favorites, and Archived with selection, focus, count, and row visibility", async () => {
        const fav = { ...CONVERSATION, id: "fav", title: "Fav Room" };
        const other = { ...CONVERSATION, id: "other", title: "Other Room" };
        const archived = { ...CONVERSATION, id: "archived", title: "Archived Room" };
        favoriteStore.write(SESSION, new Set(["fav"]));
        archiveStore.write(SESSION, new Set(["archived"]));
        rendered = await renderClient(signedInWithRooms([fav, other, archived]));
        const names = (): Array<string | null> =>
            [...rendered!.container.querySelectorAll('[data-testid="conversation-name"]')].map(
                (element) => element.textContent,
            );

        expect(rendered.container.querySelector('[role="group"][aria-label="Filter conversations"]')).not.toBeNull();
        expect(tabButton(rendered.container, "active").getAttribute("aria-pressed")).toBe("true");
        expect(tabButton(rendered.container, "favorites").getAttribute("aria-pressed")).toBe("false");
        expect(tabButton(rendered.container, "archived").getAttribute("aria-pressed")).toBe("false");
        // the Archived tab no longer renders a conversation count — just the label.
        expect(tabButton(rendered.container, "archived").textContent).toBe("Archived");
        expect(names()).toEqual(["Fav Room", "Other Room"]);

        await act(async () => tabButton(rendered!.container, "favorites").click());
        expect(tabButton(rendered.container, "active").getAttribute("aria-pressed")).toBe("false");
        expect(tabButton(rendered.container, "favorites").getAttribute("aria-pressed")).toBe("true");
        expect(tabButton(rendered.container, "archived").getAttribute("aria-pressed")).toBe("false");
        expect(document.activeElement).toBe(tabButton(rendered.container, "favorites"));
        expect(names()).toEqual(["Fav Room"]);

        await act(async () => tabButton(rendered!.container, "archived").click());
        expect(tabButton(rendered.container, "active").getAttribute("aria-pressed")).toBe("false");
        expect(tabButton(rendered.container, "favorites").getAttribute("aria-pressed")).toBe("false");
        expect(tabButton(rendered.container, "archived").getAttribute("aria-pressed")).toBe("true");
        expect(document.activeElement).toBe(tabButton(rendered.container, "archived"));
        expect(names()).toEqual(["Archived Room"]);
    });

    it("shows the no-favorites-yet state when nothing is starred", async () => {
        rendered = await renderClient(signedInClient());
        await act(async () => tabButton(rendered!.container, "favorites").click());
        expect(rendered.container.textContent).toContain("No favorite conversations yet.");
    });

    it("distinguishes 'no favorites match search' from 'no favorites yet'", async () => {
        const fav = { ...CONVERSATION, id: "fav", title: "Alpha" };
        favoriteStore.write(SESSION, new Set(["fav"]));
        rendered = await renderClient(signedInWithRooms([fav]));
        await act(async () => tabButton(rendered!.container, "favorites").click());
        const search = rendered.container.querySelector<HTMLInputElement>("#conversation-search-input")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(search, "zzz-no-match");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(rendered.container.textContent).toContain("No favorites match your search.");
        expect(rendered.container.textContent).not.toContain("No favorite conversations yet.");
    });

    it("shows the first-run state when there is no active population", async () => {
        rendered = await renderClient(signedInWithRooms([]));
        expect(rendered.container.textContent).toContain("Your agent conversations will appear here.");
    });

    it("uses the archived population to show the no-active state when every conversation is archived", async () => {
        archiveStore.write(SESSION, new Set([CONVERSATION.id]));
        rendered = await renderClient(signedInClient());
        expect(rendered.container.textContent).toContain("No active conversations.");
        expect(rendered.container.textContent).not.toContain("Your agent conversations will appear here.");
    });

    it("hides Mark all as read on Archived without clearing unread active conversations", async () => {
        const unread = { ...CONVERSATION, unread_count: 1 };
        const archived = { ...CONVERSATION, id: "archived", title: "Archived Room" };
        archiveStore.write(SESSION, new Set([archived.id]));
        const client = signedInWithRooms([unread, archived]);
        rendered = await renderClient(client);

        expect(rendered.container.querySelector('button[aria-label="Mark all as read"]')).not.toBeNull();
        await act(async () => tabButton(rendered!.container, "archived").click());
        expect(rendered.container.querySelector('button[aria-label="Mark all as read"]')).toBeNull();
        expect(
            client.getSnapshot().conversations.find((conversation) => conversation.id === unread.id)?.unread_count,
        ).toBe(1);
    });

    it("shows the active search-empty state when active conversations are hidden by search", async () => {
        rendered = await renderClient(signedInClient());
        const search = rendered.container.querySelector<HTMLInputElement>("#conversation-search-input")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(search, "zzz-no-match");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(rendered.container.textContent).toContain("No conversations match your search.");
    });

    it("shows the no-archived state when there is no archived population", async () => {
        rendered = await renderClient(signedInClient());
        await act(async () => tabButton(rendered!.container, "archived").click());
        expect(rendered.container.textContent).toContain("No archived conversations.");
    });

    it("shows the archived search-empty state when archived conversations are hidden by search", async () => {
        archiveStore.write(SESSION, new Set([CONVERSATION.id]));
        rendered = await renderClient(signedInClient());
        await act(async () => tabButton(rendered!.container, "archived").click());
        const search = rendered.container.querySelector<HTMLInputElement>("#conversation-search-input")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(search, "zzz-no-match");
            search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(rendered.container.textContent).toContain("No archived conversations match your search.");
    });

    it("switching tabs leaves selectedConversationId unchanged when the selected row is filtered out", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await act(async () => tabButton(rendered!.container, "favorites").click());
        expect(client.getSnapshot().selectedConversationId).toBe(CONVERSATION.id);
    });
});

describe("Coordinator notices in the timeline", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    const journalEvent = (seq: number, type: string, payload: JournalEvent["payload"]): JournalEvent => ({
        seq,
        convo_id: "c1",
        ts: seq,
        sender: "journal",
        type,
        payload,
    });

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    it("draws coordinator, routine and consent_decision events as one-line notices, never raw JSON", async () => {
        const client = signedInClient({
            events: [
                journalEvent(1, "coordinator", { role: "assigned" }),
                journalEvent(2, "routine", {
                    routine_id: "r1",
                    name: "daily-sweep",
                    action: "fired",
                    outcome: "applied now",
                }),
                journalEvent(3, "consent_decision", {
                    kind: "spawn",
                    decision: "approve",
                    request_id: "req-1",
                    reason: "Follows the box rules",
                }),
            ],
        });
        rendered = await renderClient(client);

        expect(
            [...rendered.container.querySelectorAll(".mj_CoordinatorNotice_text")].map((node) => node.textContent),
        ).toEqual([
            "This chat is now the Coordinator",
            "Routine fired · daily-sweep",
            "Coordinator approved the spawn request — Follows the box rules",
        ]);
        expect(rendered.container.querySelector(".mj_Unknown")).toBeNull();
    });

    it("drops summary events and unparseable Coordinator events from the timeline", async () => {
        const client = signedInClient({
            events: [
                journalEvent(1, "summary", { text: "A rolling summary" }),
                journalEvent(2, "coordinator", { role: "promoted" }),
                journalEvent(3, "routine", { action: "fired" }),
                journalEvent(4, "consent_decision", { kind: "chat" }),
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelector(".mj_Unknown")).toBeNull();
        expect(rendered.container.querySelectorAll("li.mj_EventTile")).toHaveLength(0);
    });
});

describe("tracker item cards in the timeline", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    const marker = (seq: number, payload: JournalEvent["payload"]): JournalEvent => ({
        seq,
        convo_id: "c1",
        ts: seq,
        sender: "journal",
        type: "item",
        payload: { item_id: "it_a", num: 7, kind: "question", title: "Pick a database", by: "agent", ...payload },
    });

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
    });

    const rowTexts = (container: HTMLElement): string[] =>
        [...container.querySelectorAll("li.mj_EventTile")].map(
            (row) =>
                row.querySelector(".mj_TrackerStatusPill")?.textContent ??
                row.querySelector(".mj_TrackerInlineNote_line")?.textContent ??
                row.querySelector(".mj_Markdown")?.textContent ??
                "",
        );

    it("shows a decided question once, at its closing marker, with no stale Needs you card", async () => {
        const client = signedInClient({
            events: [
                marker(1, { action: "created", awaiting: "user" }),
                { seq: 2, convo_id: "c1", ts: 2, sender: "agent:claude", type: "text", payload: { body: "Waiting" } },
                marker(3, { action: "closed", resolution: "answered", by: "user" }),
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelectorAll(".mj_TrackerCard")).toHaveLength(1);
        expect(rendered.container.querySelector(".mj_TrackerCard_needsyou")).toBeNull();
        expect(rowTexts(rendered.container)).toEqual(["Waiting", "Closed · Answered"]);
    });

    it("draws a reopened item's card open again, keeping the reopen note", async () => {
        const client = signedInClient({
            events: [
                marker(1, { action: "created", awaiting: "user" }),
                marker(2, { action: "closed", resolution: "answered", comment: { id: "c", body: "Postgres" } }),
                marker(3, { action: "reopened", awaiting: "user", by: "user" }),
            ],
        });
        rendered = await renderClient(client);

        expect(rendered.container.querySelectorAll(".mj_TrackerCard")).toHaveLength(1);
        expect(rendered.container.querySelector(".mj_TrackerCard_needsyou")).not.toBeNull();
        expect(rendered.container.querySelector(".mj_TrackerCard_comment")).toBeNull();
        expect(rowTexts(rendered.container)).toEqual(["Needs you", "You reopened #7 · Pick a database"]);
    });
});

describe("read state reporting", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;
    const observers: Array<{
        root: Element | Document | null | undefined;
        callback: IntersectionObserverCallback;
        observed: Element[];
    }> = [];
    let originalObserver: unknown;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        observers.length = 0;
        originalObserver = (globalThis as Record<string, unknown>).IntersectionObserver;
        class MockObserver {
            private readonly entry;
            public constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
                this.entry = { root: options?.root, callback, observed: [] as Element[] };
                observers.push(this.entry);
            }
            public observe(target: Element): void {
                this.entry.observed.push(target);
            }
            public unobserve(target: Element): void {
                this.entry.observed = this.entry.observed.filter((element) => element !== target);
            }
            public disconnect(): void {
                this.entry.observed = [];
            }
        }
        Object.defineProperty(globalThis, "IntersectionObserver", { value: MockObserver, configurable: true });
        // Every element measures as the same 100px box, so every intersecting row counts as visible.
        jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100 } as DOMRect);
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
        Object.defineProperty(globalThis, "IntersectionObserver", { value: originalObserver, configurable: true });
    });

    it("reports the selected conversation's on-screen rows to the client's tracker", async () => {
        const client = signedInClient({ events: [textEvent(1, "one"), textEvent(2, "two")] });
        const setVisible = jest.spyOn(client.seen, "setVisible").mockImplementation(() => {});
        const removeSurface = jest.spyOn(client.seen, "removeSurface").mockImplementation(() => {});
        rendered = await renderClient(client);

        const timeline = observers.find((observer) =>
            (observer.root as Element | undefined)?.classList?.contains("mj_ChatView_messagePanel"),
        );
        expect(timeline?.observed.map((row) => row.getAttribute("data-event-id"))).toEqual(["1", "2"]);
        await act(async () => {
            timeline!.callback(
                timeline!.observed.map(
                    (target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry,
                ),
                {} as IntersectionObserver,
            );
        });
        expect(setVisible).toHaveBeenLastCalledWith(expect.any(Symbol), "c1", [1, 2]);

        await act(async () => rendered?.root.unmount());
        rendered.container.remove();
        rendered = undefined;
        expect(removeSurface).toHaveBeenCalledWith(setVisible.mock.calls[0][0]);
    });

    it("reports nothing from a read-only subagent transcript", async () => {
        const client = signedInClient({ events: [textEvent(1, "one")] });
        internals(client).state = {
            ...client.getSnapshot(),
            conversations: [
                { ...CONVERSATION, id: "p1", title: "Parent" },
                { ...CONVERSATION, parent_convo_id: "p1" },
            ],
        };
        rendered = await renderClient(client);
        expect(rendered.container.textContent).toContain("Read-only — subagent transcript");
        expect(
            observers.some((observer) =>
                (observer.root as Element | undefined)?.classList?.contains("mj_ChatView_messagePanel"),
            ),
        ).toBe(false);
    });
});
