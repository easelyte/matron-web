/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useFocusTrap } from "../use-focus-trap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Modal({ autoFocusLast = false }: { autoFocusLast?: boolean }): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    useFocusTrap(ref);
    return (
        <div ref={ref} role="dialog" aria-modal="true">
            <button id="first">First</button>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <button id="last" autoFocus={autoFocusLast}>
                Last
            </button>
        </div>
    );
}

describe("useFocusTrap", () => {
    let container: HTMLDivElement;
    let root: Root;
    let outside: HTMLButtonElement;

    beforeEach(() => {
        outside = document.createElement("button");
        outside.id = "outside";
        document.body.append(outside);
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        outside.remove();
    });

    const open = async (props: { autoFocusLast?: boolean } = {}): Promise<void> => {
        outside.focus();
        await act(async () => root.render(<Modal {...props} />));
    };

    const tab = (shiftKey: boolean): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
        document.activeElement!.dispatchEvent(event);
        return event;
    };

    it("moves focus to the first control on open", async () => {
        await open();
        expect(document.activeElement?.id).toBe("first");
    });

    it("keeps focus on a control that already took it, such as an autoFocus field", async () => {
        await open({ autoFocusLast: true });
        expect(document.activeElement?.id).toBe("last");
    });

    it("wraps Tab from the last control to the first, and Shift+Tab back", async () => {
        await open();
        container.querySelector<HTMLElement>("#last")!.focus();
        expect(tab(false).defaultPrevented).toBe(true);
        expect(document.activeElement?.id).toBe("first");
        expect(tab(true).defaultPrevented).toBe(true);
        expect(document.activeElement?.id).toBe("last");
    });

    it("pulls focus back in when it sits outside the dialog", async () => {
        await open();
        outside.focus();
        tab(false);
        expect(document.activeElement?.id).toBe("first");
    });

    it("leaves Tab between inner controls alone", async () => {
        await open();
        container.querySelector<HTMLElement>("#first")!.focus();
        expect(tab(false).defaultPrevented).toBe(false);
    });

    it("restores focus to the opener when the dialog closes after an autoFocus field took focus", async () => {
        await open({ autoFocusLast: true });
        expect(document.activeElement?.id).toBe("last");
        await act(async () => root.render(<div />));
        expect(document.activeElement?.id).toBe("outside");
    });

    it("restores focus to the opener when the dialog closes", async () => {
        await open();
        expect(document.activeElement?.id).toBe("first");
        await act(async () => root.render(<div />));
        expect(document.activeElement?.id).toBe("outside");
    });
});
