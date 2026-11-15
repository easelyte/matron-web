/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

type FocusDocument = Pick<Document, "visibilityState" | "hasFocus">;

/** Whether the page is on screen, focused or not (a window beside an editor, a second monitor). */
export function isTabVisible(
    doc: Pick<Document, "visibilityState"> | undefined = typeof document === "undefined" ? undefined : document,
): boolean {
    return !!doc && doc.visibilityState === "visible";
}

export function isTabFocused(
    doc: FocusDocument | undefined = typeof document === "undefined" ? undefined : document,
): boolean {
    return !!doc && doc.visibilityState === "visible" && doc.hasFocus();
}

/**
 * The conversation this page tells the journal it is viewing. The journal also sends a viewed
 * conversation's live updates (streaming text, tool output, activity), so this follows what is
 * on screen, not what has focus: a visible but unfocused window keeps its live updates, and only
 * a hidden page stops viewing.
 */
export function viewingConvoId(
    selectedId: string | null | undefined,
    doc?: Pick<Document, "visibilityState">,
): string | null {
    return isTabVisible(doc) ? selectedId || null : null;
}

export function watchTabFocus(win: Window, doc: Document | undefined, onChange: () => void): () => void {
    win.addEventListener("focus", onChange);
    win.addEventListener("blur", onChange);
    doc?.addEventListener("visibilitychange", onChange);
    return () => {
        win.removeEventListener("focus", onChange);
        win.removeEventListener("blur", onChange);
        doc?.removeEventListener("visibilitychange", onChange);
    };
}
