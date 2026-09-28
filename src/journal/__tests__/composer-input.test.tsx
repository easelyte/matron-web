/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { autoGrow, COMPOSER_MAX_HEIGHT_PX, useAutoGrow } from "../composer-input";

function textareaWith(value: string, scrollHeight: number): HTMLTextAreaElement {
    const node = document.createElement("textarea");
    node.value = value;
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => scrollHeight });
    return node;
}

describe("autoGrow", () => {
    it("sizes to the content, capped at the composer max", () => {
        const node = textareaWith("a\nb\nc", 72);
        autoGrow(node);
        expect(node.style.height).toBe("72px");
        Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => 900 });
        autoGrow(node);
        expect(node.style.height).toBe(`${COMPOSER_MAX_HEIGHT_PX}px`);
    });

    it("leaves an empty box at its natural one-row height", () => {
        const node = textareaWith("", 24);
        node.style.height = "96px";
        autoGrow(node);
        expect(node.style.height).toBe("auto");
    });

    it("does not collapse a box that is not laid out (scrollHeight 0) to zero", () => {
        const node = textareaWith("draft\nkept", 0);
        autoGrow(node);
        expect(node.style.height).toBe("auto");
    });
});

describe("useAutoGrow", () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;
    let observerCallback: ResizeObserverCallback | undefined;
    const original = globalThis.ResizeObserver;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        globalThis.ResizeObserver = class {
            public constructor(callback: ResizeObserverCallback) {
                observerCallback = callback;
            }
            public observe(): void {}
            public disconnect(): void {}
            public unobserve(): void {}
        } as unknown as typeof ResizeObserver;
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        container?.remove();
        root = undefined;
        observerCallback = undefined;
        globalThis.ResizeObserver = original;
        jest.restoreAllMocks();
    });

    let heightPerLine = 24;
    function Probe({ value }: { value: string }): React.ReactElement {
        const ref = useRef<HTMLTextAreaElement>(null);
        useAutoGrow(ref, value);
        return <textarea ref={ref} rows={1} value={value} readOnly />;
    }

    async function render(value: string): Promise<HTMLTextAreaElement> {
        jest.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (
            this: HTMLTextAreaElement,
        ) {
            return this.value ? this.value.split("\n").length * heightPerLine : 0;
        });
        container ??= document.createElement("div");
        document.body.append(container);
        root ??= createRoot(container);
        await act(async () => root!.render(<Probe value={value} />));
        return container.querySelector("textarea")!;
    }

    it("sizes a value that arrives without an input event, on mount and on change", async () => {
        heightPerLine = 24;
        const node = await render("one\ntwo\nthree");
        expect(node.style.height).toBe("72px");
        await render("one");
        expect(node.style.height).toBe("24px");
        await render("");
        expect(node.style.height).toBe("auto");
    });

    it("re-measures when the box's width changes, not on its own height changes", async () => {
        heightPerLine = 24;
        const node = await render("a\nb");
        expect(node.style.height).toBe("48px");
        let width = 300;
        jest.spyOn(node, "clientWidth", "get").mockImplementation(() => width);
        // Width unchanged (0, still hidden): no re-measure, even though the content height moved.
        heightPerLine = 40;
        width = 0;
        await act(async () => observerCallback?.([], {} as ResizeObserver));
        width = 300;
        await act(async () => observerCallback?.([], {} as ResizeObserver));
        expect(node.style.height).toBe("80px");
        heightPerLine = 30;
        await act(async () => observerCallback?.([], {} as ResizeObserver));
        expect(node.style.height).toBe("80px");
    });
});
