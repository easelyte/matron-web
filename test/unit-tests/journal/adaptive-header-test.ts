/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useDismissablePopover } from "../../../src/journal/components";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type MountedProbe = {
    container: HTMLDivElement;
    root: Root;
};

const mountedProbes: MountedProbe[] = [];

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
