/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useEffect, useState, type RefObject } from "react";

const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab / Shift+Tab inside a modal while it is mounted, so focus cannot walk out to the app
 * behind the scrim. `rootRef` is the element that carries `aria-modal` (usually the scrim). With
 * nothing focusable inside, focus is held on the root. Only the topmost modal traps, so a dialog
 * opened over another keeps its own cycle.
 *
 * On mount, focus moves into the dialog unless something inside already has it (an `autoFocus`
 * field); on unmount, focus returns to the element that had it before the dialog opened.
 */
export function useFocusTrap(rootRef: RefObject<HTMLElement | null>): void {
    // Read during the first render: `autoFocus` fields take focus at commit, before any effect runs.
    const [opener] = useState(() => document.activeElement as HTMLElement | null);
    useEffect(() => {
        const root = rootRef.current;
        if (root && !root.contains(document.activeElement)) {
            const first = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.tabIndex >= 0);
            if (first) {
                first.focus();
            } else {
                if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
                root.focus();
            }
        }

        const onKey = (event: KeyboardEvent): void => {
            const root = rootRef.current;
            if (event.key !== "Tab" || event.defaultPrevented || !root) return;
            const modals = document.querySelectorAll('[aria-modal="true"]');
            const top = modals[modals.length - 1];
            // aria-modal may sit on the root or on a child of it.
            if (top && top !== root && !root.contains(top)) return;
            const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0);
            if (focusable.length === 0) {
                event.preventDefault();
                if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
                root.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (!active || !root.contains(active)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && (active === first || active === root)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            if (opener && opener !== document.body && opener.isConnected) opener.focus();
        };
    }, [rootRef, opener]);
}
