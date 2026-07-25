/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { HeaderShell, MatronApp, useAdaptiveHeader, useDismissablePopover } from "../../../src/journal/components";
import type { ClientState, Conversation, Session } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type MountedProbe = {
    container: HTMLDivElement;
    root: Root;
};

const mountedProbes: MountedProbe[] = [];

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "test-token",
    deviceId: 1,
    userId: 2,
    username: "tester",
};

const PARENT: Conversation = {
    id: "parent",
    title: "Parent conversation",
    session_state: "running",
    last_seq: 1,
    unread_count: 0,
    snippet: "",
    created_at: 1,
    read_up_to_seq: 0,
};

const CHILDREN: Conversation[] = [
    {
        ...PARENT,
        id: "running-child",
        title: "Running child",
        parent_convo_id: PARENT.id,
        created_at: 2,
    },
    {
        ...PARENT,
        id: "finished-child",
        title: "Finished child",
        parent_convo_id: PARENT.id,
        session_state: "finished",
        created_at: 3,
    },
];

type ClientInternals = {
    state: ClientState;
    listeners: Set<() => void>;
};

function clientInternals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function signedInClient(): MatronJournalClient {
    const client = new MatronJournalClient();
    const internals = clientInternals(client);
    internals.state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations: [PARENT, ...CHILDREN],
        selectedConversationId: undefined,
        events: [],
        pendingMessages: [],
        connection: "online",
        sessionStatus: {
            limits: [{ label: "Session", percent: 72, resets: "in 2 hours" }],
        },
    };
    jest.spyOn(client, "selectConversation").mockImplementation(async (conversationId) => {
        internals.state = {
            ...internals.state,
            selectedConversationId: conversationId,
            sessionStatus: {
                limits: [{ label: "Session", percent: 72, resets: "in 2 hours" }],
            },
        };
        internals.listeners.forEach((listener) => listener());
    });
    return client;
}

function Probe({ close, open = true }: { close: () => void; open?: boolean }): React.ReactElement {
    const openerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    useDismissablePopover(open, close, { openerRef, panelRef });
    return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", { ref: openerRef }, "Open"),
        React.createElement("div", { ref: panelRef }, "Panel", React.createElement("span", null, "Panel child")),
    );
}

async function mountProbe(close = jest.fn()): Promise<MountedProbe> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const mounted = { container, root };
    mountedProbes.push(mounted);
    await act(async () => root.render(React.createElement(Probe, { close })));
    return mounted;
}

function headerProps(
    overrides: Partial<React.ComponentProps<typeof HeaderShell>> = {},
): React.ComponentProps<typeof HeaderShell> {
    return {
        mode: "parent",
        onBack: jest.fn(),
        backLabel: "Back",
        left: null,
        hasLeft: false,
        title: "Conversation",
        titleMeta: null,
        collapse: { usageCollapsed: false, titleCollapsed: false },
        ...overrides,
    };
}

async function mountHeader(overrides: Partial<React.ComponentProps<typeof HeaderShell>> = {}): Promise<MountedProbe> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const mounted = { container, root };
    mountedProbes.push(mounted);
    await act(async () => root.render(React.createElement(HeaderShell, headerProps(overrides))));
    return mounted;
}

function AdaptiveProbe({ el, onRender }: { el: HTMLElement | null; onRender?: () => void }): React.ReactElement {
    onRender?.();
    return React.createElement("output", null, JSON.stringify(useAdaptiveHeader(el)));
}

async function mountAdaptiveProbe(
    el: HTMLElement | null,
    onRender?: () => void,
): Promise<MountedProbe & { render: (nextEl: HTMLElement | null) => Promise<void> }> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const mounted = { container, root };
    mountedProbes.push(mounted);
    const render = async (nextEl: HTMLElement | null): Promise<void> => {
        await act(async () => root.render(React.createElement(AdaptiveProbe, { el: nextEl, onRender })));
    };
    await render(el);
    return { ...mounted, render };
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
    await act(async () => {
        for (const { container, root } of mountedProbes.splice(0)) {
            root.unmount();
            container.remove();
        }
    });
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe("useDismissablePopover", () => {
    it("closes on pointerdown outside the opener and panel", async () => {
        const close = jest.fn();
        await mountProbe(close);

        await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));

        expect(close).toHaveBeenCalledTimes(1);
    });

    it("does not close on pointerdown on the opener", async () => {
        const close = jest.fn();
        const { container } = await mountProbe(close);

        await act(async () =>
            container.querySelector("button")!.dispatchEvent(new Event("pointerdown", { bubbles: true })),
        );

        expect(close).not.toHaveBeenCalled();
    });

    it("closes on Escape and returns focus to the opener", async () => {
        const close = jest.fn();
        const { container } = await mountProbe(close);
        const opener = container.querySelector("button")!;
        container.querySelector<HTMLElement>("div")!.focus();

        await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));

        expect(close).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(opener);
    });

    it("closes on outside scroll but not scroll inside the panel", async () => {
        const close = jest.fn();
        const { container } = await mountProbe(close);
        const panelChild = container.querySelector("span")!;

        await act(async () => panelChild.dispatchEvent(new Event("scroll")));
        expect(close).not.toHaveBeenCalled();

        await act(async () => document.body.dispatchEvent(new Event("scroll")));
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("removes all document listeners when closed and unmounted", async () => {
        const removeEventListener = jest.spyOn(document, "removeEventListener");
        const close = jest.fn();
        const { container, root } = await mountProbe(close);

        await act(async () => root.render(React.createElement(Probe, { close, open: false })));

        expect(removeEventListener).toHaveBeenCalledWith("pointerdown", expect.any(Function));
        expect(removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
        expect(removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), true);

        close.mockClear();
        await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
        expect(close).not.toHaveBeenCalled();

        await act(async () => root.unmount());
        container.remove();
        mountedProbes.splice(
            mountedProbes.findIndex((mounted) => mounted.root === root),
            1,
        );
    });
});

describe("useAdaptiveHeader", () => {
    type ObserverCallback = ResizeObserverCallback;
    type ObserverRecord = {
        callback: ObserverCallback;
        disconnect: jest.Mock;
        observe: jest.Mock;
    };

    let observers: ObserverRecord[];
    let frames: Map<number, FrameRequestCallback>;
    let nextFrame: number;

    beforeEach(() => {
        observers = [];
        frames = new Map();
        nextFrame = 1;
        class MockResizeObserver {
            public readonly disconnect = jest.fn();
            public readonly observe = jest.fn();

            public constructor(callback: ObserverCallback) {
                observers.push({ callback, disconnect: this.disconnect, observe: this.observe });
            }
        }
        globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
        jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
            const handle = nextFrame++;
            frames.set(handle, callback);
            return handle;
        });
        jest.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((handle) => {
            frames.delete(handle);
        });
    });

    const resize = (observer: ObserverRecord, target: Element, width: number): void => {
        observer.callback(
            [
                {
                    target,
                    borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
                    contentBoxSize: [],
                    devicePixelContentBoxSize: [],
                    contentRect: { width } as DOMRectReadOnly,
                },
            ],
            {} as ResizeObserver,
        );
    };

    const flushFrames = async (): Promise<void> => {
        const queued = [...frames.values()];
        frames.clear();
        await act(async () => queued.forEach((callback) => callback(performance.now())));
    };

    it("maps observed widths to usage and title collapse flags", async () => {
        const el = document.createElement("div");
        const probe = await mountAdaptiveProbe(el);
        const observer = observers[0];

        expect(observer.observe).toHaveBeenCalledWith(el);
        expect(probe.container.textContent).toBe('{"usageCollapsed":false,"titleCollapsed":false}');

        resize(observer, el, 900);
        await flushFrames();
        expect(probe.container.textContent).toBe('{"usageCollapsed":false,"titleCollapsed":false}');

        resize(observer, el, 560);
        await flushFrames();
        expect(probe.container.textContent).toBe('{"usageCollapsed":true,"titleCollapsed":false}');

        resize(observer, el, 400);
        await flushFrames();
        expect(probe.container.textContent).toBe('{"usageCollapsed":true,"titleCollapsed":true}');
    });

    it("coalesces resize callbacks into one frame and renders only when flags flip", async () => {
        const el = document.createElement("div");
        const onRender = jest.fn();
        await mountAdaptiveProbe(el, onRender);
        const observer = observers[0];

        resize(observer, el, 900);
        resize(observer, el, 850);
        expect(frames.size).toBe(1);
        await flushFrames();
        expect(onRender).toHaveBeenCalledTimes(1);

        resize(observer, el, 560);
        await flushFrames();
        expect(onRender).toHaveBeenCalledTimes(2);

        resize(observer, el, 550);
        await flushFrames();
        expect(onRender).toHaveBeenCalledTimes(2);
    });

    it("fails soft for a null element or missing ResizeObserver", async () => {
        const nullProbe = await mountAdaptiveProbe(null);
        expect(nullProbe.container.textContent).toBe('{"usageCollapsed":false,"titleCollapsed":false}');
        expect(observers).toHaveLength(0);

        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
        const elProbe = await mountAdaptiveProbe(document.createElement("div"));
        expect(elProbe.container.textContent).toBe('{"usageCollapsed":false,"titleCollapsed":false}');
        expect(observers).toHaveLength(0);
    });

    it("disconnects the old observer and observes a new element when identity changes", async () => {
        const firstEl = document.createElement("div");
        const secondEl = document.createElement("div");
        const probe = await mountAdaptiveProbe(firstEl);
        const firstObserver = observers[0];
        resize(firstObserver, firstEl, 400);

        await probe.render(secondEl);

        expect(firstObserver.disconnect).toHaveBeenCalledTimes(1);
        expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
        expect(observers).toHaveLength(2);
        expect(observers[1].observe).toHaveBeenCalledWith(secondEl);

        resize(observers[1], secondEl, 560);
        await flushFrames();
        expect(probe.container.textContent).toBe('{"usageCollapsed":true,"titleCollapsed":false}');
    });

    it("reattaches after the full app returns home and remounts a conversation", async () => {
        const client = signedInClient();
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        mountedProbes.push({ container, root });

        await act(async () => root.render(React.createElement(MatronApp, { client })));
        expect(container.querySelector(".mx_RoomView_body")).toBeNull();
        expect(observers).toHaveLength(0);

        await act(async () => client.selectConversation(PARENT.id));
        const firstBody = container.querySelector<HTMLElement>(".mx_RoomView_body")!;
        expect(firstBody).not.toBeNull();
        expect(observers).toHaveLength(1);
        expect(observers[0].observe).toHaveBeenCalledWith(firstBody);
        expect(container.textContent).toContain("Finished child");

        resize(observers[0], firstBody, 560);
        await flushFrames();
        expect(container.querySelector(".mj_HeaderMiniUsage")).not.toBeNull();

        await act(async () => client.clearSelection());
        expect(container.querySelector(".mx_RoomView_body")).toBeNull();
        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);

        await act(async () => client.selectConversation(PARENT.id));
        const secondBody = container.querySelector<HTMLElement>(".mx_RoomView_body")!;
        expect(secondBody).not.toBe(firstBody);
        expect(observers).toHaveLength(2);
        expect(observers[1].observe).toHaveBeenCalledWith(secondBody);

        resize(observers[1], secondBody, 560);
        await flushFrames();
        expect(container.querySelector(".mj_HeaderMiniUsage")).not.toBeNull();
    });
});

describe("HeaderShell", () => {
    it("keeps one level-one title heading and labels the collapsed disclosure from it", async () => {
        const mounted = await mountHeader({
            title: "Stable conversation title",
            collapse: { usageCollapsed: false, titleCollapsed: true },
        });
        const headings = mounted.container.querySelectorAll('[role="heading"][aria-level="1"]');
        const disclosure = mounted.container.querySelector(".mj_HeaderMiniTitle");

        expect(headings).toHaveLength(1);
        expect(headings[0].textContent).toBe("Stable conversation title");
        expect(headings[0].closest(".mj_HeaderTitleCluster_hidden")).not.toBeNull();
        expect(disclosure?.getAttribute("aria-labelledby")).toBe(headings[0].id);

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({
                        title: "Stable conversation title",
                        collapse: { usageCollapsed: false, titleCollapsed: false },
                    }),
                ),
            ),
        );

        const expandedHeadings = mounted.container.querySelectorAll('[role="heading"][aria-level="1"]');
        expect(expandedHeadings).toHaveLength(1);
        expect(expandedHeadings[0]).toBe(headings[0]);
        expect(expandedHeadings[0].closest(".mj_HeaderTitleCluster_hidden")).toBeNull();
    });

    it("refreshes the collapsed usage reset label on the minute clock", async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-07-24T12:00:00Z"));
        const { container } = await mountHeader({
            hasLeft: true,
            left: React.createElement("span", null, "Model"),
            limits: [{ label: "Session", percent: 72, resets_at: "2026-07-24T12:03:00Z" }],
            collapse: { usageCollapsed: true, titleCollapsed: false },
        });
        const miniUsage = container.querySelector(".mj_HeaderMiniUsage");

        expect(miniUsage?.getAttribute("aria-label")).toBe("Usage — worst limit 72%, resets 3m");

        await act(async () => jest.advanceTimersByTime(60_000));

        expect(miniUsage?.getAttribute("aria-label")).toBe("Usage — worst limit 72%, resets 2m");
    });

    it("marks an empty left cluster hidden when expanded and in the collapsed title popover", async () => {
        const mounted = await mountHeader();
        const expandedLeft = mounted.container.querySelector(".mj_ModelContextCluster");

        expect(expandedLeft?.classList.contains("mj_HeaderCluster_empty")).toBe(true);
        expect(expandedLeft?.getAttribute("aria-hidden")).toBe("true");

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({ collapse: { usageCollapsed: false, titleCollapsed: true } }),
                ),
            ),
        );
        await act(async () =>
            mounted.container
                .querySelector<HTMLButtonElement>(".mj_HeaderMiniTitle")!
                .dispatchEvent(new MouseEvent("click", { bubbles: true })),
        );

        const popoverLeft = mounted.container.querySelector(".mj_TitlePopover .mj_ModelContextCluster");
        expect(popoverLeft?.classList.contains("mj_HeaderCluster_empty")).toBe(true);
        expect(popoverLeft?.getAttribute("aria-hidden")).toBe("true");
    });

    it("moves focus from the Compact button to the mini-title when the title collapses", async () => {
        const mounted = await mountHeader({
            hasLeft: true,
            left: React.createElement("button", { "aria-label": "Compact conversation" }, "Compact"),
        });
        const compact = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Compact conversation"]')!;

        compact.focus();
        expect(document.activeElement).toBe(compact);

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({
                        hasLeft: true,
                        left: React.createElement("button", { "aria-label": "Compact conversation" }, "Compact"),
                        collapse: { usageCollapsed: false, titleCollapsed: true },
                    }),
                ),
            ),
        );

        const miniTitle = mounted.container.querySelector<HTMLButtonElement>(".mj_HeaderMiniTitle");
        expect(document.activeElement).toBe(miniTitle);
        expect(document.activeElement).not.toBe(document.body);
    });

    it("moves focus into a populated usage panel and restores it on expansion", async () => {
        const mounted = await mountHeader({
            limits: [{ label: "Session", percent: 72 }],
            collapse: { usageCollapsed: true, titleCollapsed: false },
        });
        const trigger = mounted.container.querySelector<HTMLButtonElement>(".mj_HeaderMiniUsage")!;

        await act(async () => trigger.click());
        const panel = mounted.container.querySelector<HTMLElement>(".mj_UsagePopover")!;
        expect(document.activeElement).toBe(panel);

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({
                        limits: [{ label: "Session", percent: 72 }],
                        collapse: { usageCollapsed: false, titleCollapsed: false },
                    }),
                ),
            ),
        );

        const header = mounted.container.querySelector<HTMLElement>(".mj_ChatHeader");
        expect(header?.tabIndex).toBe(-1);
        expect(document.activeElement).toBe(header);
        expect(document.activeElement).not.toBe(document.body);
    });

    it("does not restore stale focus after Escape and expansion consume ownership", async () => {
        const mounted = await mountHeader({
            limits: [{ label: "Session", percent: 72 }],
            collapse: { usageCollapsed: true, titleCollapsed: false },
        });
        const trigger = mounted.container.querySelector<HTMLButtonElement>(".mj_HeaderMiniUsage")!;

        await act(async () => trigger.click());
        await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
        expect(document.activeElement).toBe(trigger);

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({
                        limits: [{ label: "Session", percent: 72 }],
                        collapse: { usageCollapsed: false, titleCollapsed: false },
                    }),
                ),
            ),
        );

        const header = mounted.container.querySelector<HTMLElement>(".mj_ChatHeader")!;
        const userFocusTarget = mounted.container.querySelector<HTMLButtonElement>(".mj_BackButton")!;
        expect(document.activeElement).toBe(header);
        userFocusTarget.focus();

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({
                        limits: [
                            { label: "Session", percent: 72 },
                            { label: "Weekly", percent: 35 },
                        ],
                        collapse: { usageCollapsed: false, titleCollapsed: false },
                    }),
                ),
            ),
        );

        expect(document.activeElement).toBe(userFocusTarget);
    });

    it("restores focus when an open usage popover loses all limits", async () => {
        const mounted = await mountHeader({
            limits: [{ label: "Session", percent: 72 }],
            collapse: { usageCollapsed: true, titleCollapsed: false },
        });

        await act(async () => mounted.container.querySelector<HTMLButtonElement>(".mj_HeaderMiniUsage")!.click());
        expect(document.activeElement).toBe(mounted.container.querySelector(".mj_UsagePopover"));

        await act(async () =>
            mounted.root.render(
                React.createElement(
                    HeaderShell,
                    headerProps({
                        limits: [],
                        collapse: { usageCollapsed: true, titleCollapsed: false },
                    }),
                ),
            ),
        );

        const header = mounted.container.querySelector<HTMLElement>(".mj_ChatHeader");
        expect(header?.tabIndex).toBe(-1);
        expect(document.activeElement).toBe(header);
        expect(document.activeElement).not.toBe(document.body);
    });
});
