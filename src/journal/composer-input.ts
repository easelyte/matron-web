/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Text-box behaviour for the chat composer: which keypress sends, and how the box grows with its
 * content.
 */

import type React from "react";
import { useCallback, useLayoutEffect, useState } from "react";

/** The composer grows with its content up to this height (eight lines), then scrolls. */
export const COMPOSER_MAX_HEIGHT_PX = 144;

/**
 * True while an IME composition is in flight. Enter then commits the candidate, it must not send.
 * keyCode 229 covers browsers that report the composing keydown without `isComposing`.
 */
export function isImeComposing(event: React.KeyboardEvent): boolean {
    return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** The send key: Enter without Shift (Shift+Enter inserts a newline), and not mid-composition. */
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
 * Keep a textarea sized to its value. Runs on mount and on every value change, whether it came
 * from typing, a restored draft, a cleared send or a programmatic insert, so a restored draft
 * opens at its full height instead of one row. It also re-measures when the box's width changes
 * (a hidden pane becoming visible, a rotation, a pane resize), since the wrap, and so the height,
 * depends on it.
 *
 * The hook tracks the element itself, not the ref object: the composer unmounts its textarea while
 * a voice note records and mounts a new one afterwards, and a ref object would not change across
 * that. Attach the returned callback ref to the textarea; it also keeps `ref` up to date.
 */
export function useAutoGrow(
    ref: React.MutableRefObject<HTMLTextAreaElement | null>,
    value: string,
    maxPx: number = COMPOSER_MAX_HEIGHT_PX,
): (node: HTMLTextAreaElement | null) => void {
    const [node, setNode] = useState<HTMLTextAreaElement | null>(null);
    const attach = useCallback(
        (el: HTMLTextAreaElement | null) => {
            ref.current = el;
            setNode(el);
        },
        [ref],
    );

    useLayoutEffect(() => {
        if (node) autoGrow(node, maxPx);
    }, [node, value, maxPx]);

    useLayoutEffect(() => {
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
    }, [node, maxPx]);

    return attach;
}
