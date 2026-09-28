/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Shared behaviour for the message-style text boxes (chat composer, tracker reply box, upload
 * caption): which keypress sends, and how the box grows with its content.
 */

import type React from "react";
import { useLayoutEffect } from "react";

/** The composer grows with its content up to this height, then scrolls. */
export const COMPOSER_MAX_HEIGHT_PX = 160;

/**
 * True while an IME composition is in flight. Enter then commits the candidate, it must not send.
 * keyCode 229 covers browsers that report the composing keydown without `isComposing`.
 */
export function isImeComposing(event: React.KeyboardEvent): boolean {
    return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * The send key: Enter without Shift (Shift+Enter inserts a newline). Cmd/Ctrl+Enter also sends.
 * Same on touch keyboards: the return key sends, exactly as in the chat composer.
 */
export function isSendKey(event: React.KeyboardEvent): boolean {
    if (isImeComposing(event)) return false;
    return event.key === "Enter" && !event.shiftKey;
}

/**
 * Size a textarea to its content, capped at `maxPx`. An empty box falls back to its natural
 * one-row height. A box that is not laid out (display:none, detached) reports a scrollHeight of 0;
 * it keeps its natural height rather than collapsing to 0px.
 */
export function autoGrow(node: HTMLTextAreaElement, maxPx: number = COMPOSER_MAX_HEIGHT_PX): void {
    node.style.height = "auto";
    if (!node.value) return;
    const height = node.scrollHeight;
    if (height > 0) node.style.height = `${Math.min(height, maxPx)}px`;
}

/**
 * Keep a textarea sized to its value. Runs on mount and on EVERY value change, whether it came
 * from typing, a restored draft, a cleared send or a programmatic insert, so a restored draft
 * opens at its full height instead of one row. It also re-measures when the box's width changes
 * (a hidden pane becoming visible, a rotation, a pane resize), since the wrap and so the height
 * depend on it.
 */
export function useAutoGrow(
    ref: React.RefObject<HTMLTextAreaElement | null>,
    value: string,
    maxPx: number = COMPOSER_MAX_HEIGHT_PX,
): void {
    useLayoutEffect(() => {
        const node = ref.current;
        if (node) autoGrow(node, maxPx);
    }, [ref, value, maxPx]);

    useLayoutEffect(() => {
        const node = ref.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        let lastWidth = node.clientWidth;
        const observer = new ResizeObserver(() => {
            // Height changes are our own doing; only a width change can change the wrap.
            if (node.clientWidth === lastWidth) return;
            lastWidth = node.clientWidth;
            autoGrow(node, maxPx);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref, maxPx]);
}
