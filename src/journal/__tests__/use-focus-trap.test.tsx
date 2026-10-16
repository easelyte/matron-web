/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useFocusTrap } from "../use-focus-trap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Modal(): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    useFocusTrap(ref);
    return (
        <div ref={ref} role="dialog" aria-modal="true">
            <button id="first">First</button>
            <button id="last">Last</button>
        </div>
    );
}

describe("useFocusTrap", () => {
    let container: HTMLDivElement;
    let root: Root;
    let outside: HTMLButtonElement;

    beforeEach(async () => {
        outside = document.createElement("button");
        document.body.append(outside);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root.render(<Modal />));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        outside.remove();
    });

    const tab = (shiftKey: boolean): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
        document.activeElement!.dispatchEvent(event);
        return event;
    };

    it("wraps Tab from the last control to the first, and Shift+Tab back", () => {
        container.querySelector<HTMLElement>("#last")!.focus();
        expect(tab(false).defaultPrevented).toBe(true);
        expect(document.activeElement?.id).toBe("first");
        expect(tab(true).defaultPrevented).toBe(true);
        expect(document.activeElement?.id).toBe("last");
    });

    it("pulls focus back in when it sits outside the dialog", () => {
        outside.focus();
        tab(false);
        expect(document.activeElement?.id).toBe("first");
    });

    it("leaves Tab between inner controls alone", () => {
        container.querySelector<HTMLElement>("#first")!.focus();
        expect(tab(false).defaultPrevented).toBe(false);
    });
});
