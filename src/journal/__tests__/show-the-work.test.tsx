/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
    readShowTheWork,
    resetShowTheWorkForTests,
    SHOW_THE_WORK_KEY,
    useShowTheWork,
    writeShowTheWork,
} from "../show-the-work";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): React.ReactElement {
    const [on, set] = useShowTheWork();
    return (
        <button type="button" onClick={() => set(!on)}>
            {on ? "on" : "off"}
        </button>
    );
}

describe("Show the work preference", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        localStorage.clear();
        resetShowTheWorkForTests();
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it("defaults to OFF", () => {
        expect(readShowTheWork()).toBe(false);
        act(() => root.render(<Probe />));
        expect(container.textContent).toBe("off");
    });

    it("persists under matron.showTheWork and re-renders every subscriber", () => {
        act(() => root.render(<Probe />));
        act(() => container.querySelector("button")!.click());
        expect(container.textContent).toBe("on");
        expect(localStorage.getItem(SHOW_THE_WORK_KEY)).toBe("true");
        act(() => writeShowTheWork(false));
        expect(container.textContent).toBe("off");
        expect(localStorage.getItem(SHOW_THE_WORK_KEY)).toBeNull();
    });

    it("follows a change made in another tab", () => {
        act(() => root.render(<Probe />));
        act(() => {
            localStorage.setItem(SHOW_THE_WORK_KEY, "true");
            window.dispatchEvent(new StorageEvent("storage", { key: SHOW_THE_WORK_KEY }));
        });
        expect(container.textContent).toBe("on");
    });
});
