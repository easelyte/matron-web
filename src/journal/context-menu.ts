/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createLongPressController, type LongPressController } from "./longPress";

const MARGIN = 8;

export function clampToViewport(left: number, top: number, width: number, height: number, vw: number, vh: number) {
    return {
        left: Math.max(MARGIN, Math.min(left, vw - width - MARGIN)),
        top: Math.max(MARGIN, Math.min(top, vh - height - MARGIN)),
    };
}

export function nextMenuIndex(current: number, delta: 1 | -1, count: number): number {
    if (count === 0) return -1;
    if (current === -1) return delta === 1 ? 0 : count - 1;
    return (current + delta + count) % count;
}

export interface RowContextMenu<T> {
    state: { target: T; left: number; top: number } | undefined;
    menuRef: React.RefObject<HTMLDivElement | null>;
    openerRef: React.MutableRefObject<HTMLElement | null>;
    open(target: T, left: number, top: number, opener: HTMLElement | null): void;
    close(restoreFocus?: boolean): void;
    rowHandlers(
        target: T,
        getRow: () => HTMLElement | null,
    ): {
        onContextMenu(e: React.MouseEvent): void;
        onPointerDown(e: React.PointerEvent): void;
        onPointerMove(e: React.PointerEvent): void;
        onPointerUp(e: React.PointerEvent): void;
        onPointerCancel(e: React.PointerEvent): void;
        onClickCapture(e: React.MouseEvent): void;
    };
    menuKeyDown(e: React.KeyboardEvent): void;
}

export function useRowContextMenu<T>(opts?: { longPressMs?: number }): RowContextMenu<T> {
    const [state, setState] = useState<{ target: T; left: number; top: number }>();
    const stateRef = useRef(state);
    stateRef.current = state;
    const menuRef = useRef<HTMLDivElement | null>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    const pressTargetRef = useRef<
        | {
              target: T;
              getRow: () => HTMLElement | null;
              pointerId: number;
              pointerTarget: EventTarget | null;
          }
        | undefined
    >(undefined);
    const controllerRef = useRef<LongPressController | undefined>(undefined);
    const pressScrollCleanupRef = useRef<() => void>(() => undefined);
    const didFireRef = useRef(false);

    const open = useCallback((target: T, left: number, top: number, opener: HTMLElement | null) => {
        openerRef.current = opener;
        setState({ target, left, top });
    }, []);
    const close = useCallback((restoreFocus = false) => {
        if (!stateRef.current) return;
        setState(undefined);
        if (restoreFocus) openerRef.current?.focus();
    }, []);

    if (!controllerRef.current) {
        controllerRef.current = createLongPressController({
            delayMs: opts?.longPressMs ?? 500,
            onFire: () => {
                didFireRef.current = true;
                pressScrollCleanupRef.current();
                const p = pressTargetRef.current;
                if (!p) return;
                const row = p.getRow();
                if (!row) return;
                const rect = row.getBoundingClientRect();
                open(p.target, rect.right, rect.top, row);
            },
        });
    }

    useEffect(() => {
        if (!state) return;
        const onDown = (e: PointerEvent) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close(true);
        };
        const onScroll = () => close();
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [Boolean(state), close]);

    useLayoutEffect(() => {
        if (!state || !menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const c = clampToViewport(
            state.left,
            state.top,
            rect.width,
            rect.height,
            window.innerWidth,
            window.innerHeight,
        );
        if (c.left !== state.left || c.top !== state.top) setState({ ...state, left: c.left, top: c.top });
        menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [state]);

    useEffect(
        () => () => {
            controllerRef.current?.onPointerCancel();
            pressScrollCleanupRef.current();
        },
        [],
    );

    const rowHandlers = useCallback(
        (target: T, getRow: () => HTMLElement | null) => ({
            onContextMenu(e: React.MouseEvent) {
                e.preventDefault();
                const row = getRow();
                if (!row) return;
                const keyboard = e.clientX === 0 && e.clientY === 0;
                const rect = row.getBoundingClientRect();
                if (keyboard) open(target, rect.right, rect.bottom, row);
                else open(target, e.clientX, e.clientY, row);
            },
            onPointerDown(e: React.PointerEvent) {
                if (e.pointerType !== "touch") return;
                const activePress = pressTargetRef.current;
                if (activePress && (controllerRef.current?.isPending || didFireRef.current)) {
                    if (activePress.pointerId !== e.pointerId) return;
                }
                didFireRef.current = false;
                pressTargetRef.current = {
                    target,
                    getRow,
                    pointerId: e.pointerId,
                    pointerTarget: e.currentTarget,
                };
                controllerRef.current?.onPointerDown(e.clientX, e.clientY);
                pressScrollCleanupRef.current();
                const onScroll = () => {
                    controllerRef.current?.onPointerCancel();
                    pressScrollCleanupRef.current();
                };
                document.addEventListener("scroll", onScroll, true);
                pressScrollCleanupRef.current = () => {
                    document.removeEventListener("scroll", onScroll, true);
                    pressScrollCleanupRef.current = () => undefined;
                };
            },
            onPointerMove(e: React.PointerEvent) {
                if (e.pointerType !== "touch" || pressTargetRef.current?.pointerId !== e.pointerId) return;
                controllerRef.current?.onPointerMove(e.clientX, e.clientY);
            },
            onPointerUp(e: React.PointerEvent) {
                if (e.pointerType !== "touch" || pressTargetRef.current?.pointerId !== e.pointerId) return;
                controllerRef.current?.onPointerUp();
                pressScrollCleanupRef.current();
                if (!didFireRef.current) pressTargetRef.current = undefined;
            },
            onPointerCancel(e: React.PointerEvent) {
                if (e.pointerType !== "touch" || pressTargetRef.current?.pointerId !== e.pointerId) return;
                controllerRef.current?.onPointerCancel();
                pressScrollCleanupRef.current();
                didFireRef.current = false;
                pressTargetRef.current = undefined;
            },
            onClickCapture(e: React.MouseEvent) {
                const press = pressTargetRef.current;
                if (!didFireRef.current || !press || e.currentTarget !== press.pointerTarget) return;
                const pointerId = (e.nativeEvent as PointerEvent).pointerId;
                if (typeof pointerId === "number" && pointerId !== press.pointerId) return;
                e.preventDefault();
                e.stopPropagation();
                didFireRef.current = false;
                pressTargetRef.current = undefined;
            },
        }),
        [open],
    );

    const menuKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
            const idx = items.findIndex((i) => i === document.activeElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                items[nextMenuIndex(idx, e.key === "ArrowDown" ? 1 : -1, items.length)]?.focus();
            } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                items[idx]?.click();
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(true);
            }
        },
        [close],
    );

    return { state, menuRef, openerRef, open, close, rowHandlers, menuKeyDown };
}
