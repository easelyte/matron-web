/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type RefObject, useEffect } from "react";

/**
 * Closes an open popover on a pointer press outside its opener and panel, on Escape (focus
 * goes back to the opener) and on a scroll outside the panel. Its own module so the header
 * controls in other files can use it without importing components.tsx.
 */
export function useDismissablePopover(
    open: boolean,
    close: () => void,
    refs: { openerRef: RefObject<HTMLElement | null>; panelRef: RefObject<HTMLElement | null> },
): void {
    const { openerRef, panelRef } = refs;
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target as Node;
            if (!openerRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            close();
            openerRef.current?.focus();
        };
        const onScroll = (event: Event): void => {
            if (!panelRef.current?.contains(event.target as Node)) close();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [open, close, openerRef, panelRef]);
}
