/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";

import { clampToViewport, nextMenuIndex, useRowContextMenu } from "../../../src/journal/context-menu";

test("clamp keeps an in-bounds menu unchanged", () => {
    expect(clampToViewport(100, 100, 200, 150, 1000, 800)).toEqual({ left: 100, top: 100 });
});
test("clamp pulls a right/bottom overflow inside with 8px margin", () => {
    expect(clampToViewport(950, 780, 200, 150, 1000, 800)).toEqual({ left: 1000 - 200 - 8, top: 800 - 150 - 8 });
});
test("clamp floors at 8px on the top/left", () => {
    expect(clampToViewport(-50, -50, 100, 100, 1000, 800)).toEqual({ left: 8, top: 8 });
});
test("nextMenuIndex cycles forward and wraps", () => {
    expect(nextMenuIndex(-1, 1, 3)).toBe(0);
    expect(nextMenuIndex(2, 1, 3)).toBe(0);
});
test("nextMenuIndex cycles backward and wraps", () => {
    expect(nextMenuIndex(-1, -1, 3)).toBe(2);
    expect(nextMenuIndex(0, -1, 3)).toBe(2);
});

test("a fired long-press suppresses the next nested click", async () => {
    jest.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onClick = jest.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Harness(): React.ReactElement {
        const menu = useRowContextMenu<string>();
        const row = useRef<HTMLDivElement>(null);
        const handlers = menu.rowHandlers("target", () => row.current);
        return React.createElement(
            "div",
            { ref: row, ...handlers },
            React.createElement("button", { onClick }, "Nested action"),
        );
    }

    await act(async () => root.render(React.createElement(Harness)));
    const nested = container.querySelector("button")!;
    const pointerDown = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
    });
    Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
    await act(async () => {
        nested.dispatchEvent(pointerDown);
        jest.advanceTimersByTime(500);
    });
    await act(async () => nested.click());

    expect(onClick).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
});

test("an unrelated pointer cannot disarm another pointer's long-press click suppression", async () => {
    jest.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const firstClick = jest.fn();
    const secondClick = jest.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Harness(): React.ReactElement {
        const menu = useRowContextMenu<string>();
        const firstRow = useRef<HTMLDivElement>(null);
        const secondRow = useRef<HTMLDivElement>(null);
        return React.createElement(
            React.Fragment,
            null,
            React.createElement(
                "div",
                { ref: firstRow, ...menu.rowHandlers("first", () => firstRow.current) },
                React.createElement("button", { onClick: firstClick }, "First action"),
            ),
            React.createElement(
                "div",
                { ref: secondRow, ...menu.rowHandlers("second", () => secondRow.current) },
                React.createElement("button", { onClick: secondClick }, "Second action"),
            ),
        );
    }

    const pointerEvent = (type: string, pointerId: number): MouseEvent => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
        Object.defineProperties(event, {
            pointerType: { value: "touch" },
            pointerId: { value: pointerId },
        });
        return event;
    };

    await act(async () => root.render(React.createElement(Harness)));
    const [first, second] = [...container.querySelectorAll("button")];
    await act(async () => {
        first.dispatchEvent(pointerEvent("pointerdown", 1));
        jest.advanceTimersByTime(500);
        second.dispatchEvent(pointerEvent("pointerdown", 2));
    });
    await act(async () => second.dispatchEvent(pointerEvent("click", 2)));
    expect(secondClick).toHaveBeenCalledTimes(1);
    await act(async () => first.dispatchEvent(pointerEvent("click", 1)));
    expect(firstClick).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
});
