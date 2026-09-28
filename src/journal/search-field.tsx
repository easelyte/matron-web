/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { useRef } from "react";

import { isImeComposing } from "./composer-input";
import { CloseIcon, SearchIcon } from "./icons";

/**
 * The one search field: a leading search icon, the input, and a clear (x) button while there is
 * text. The bar itself (`.mj_SearchField`, controls.pcss) owns the border, radius, hover and the
 * focus ring, so every state covers the whole rounded bar rather than the inner <input>.
 *
 * Clearing (the x, or Escape while there is text) empties the field through `onChange("")` and
 * keeps focus in it. Escape on an empty field is left alone so the outer Escape ladder still runs.
 */
export function SearchField({
    value,
    onChange,
    label,
    placeholder,
    id,
    className,
    maxLength,
}: {
    value: string;
    onChange: (next: string) => void;
    /** Accessible name of the input (e.g. "Search", "Search work"). */
    label: string;
    placeholder?: string;
    id?: string;
    /** Extra classes on the bar, e.g. a variant or a layout hook. */
    className?: string;
    maxLength?: number;
}): React.ReactElement {
    const inputRef = useRef<HTMLInputElement>(null);
    const clear = (): void => {
        onChange("");
        inputRef.current?.focus();
    };
    return (
        <div
            className={`mj_SearchField${className ? ` ${className}` : ""}`}
            // The whole bar is the target: a press on the icon or padding focuses the field (as the
            // <label> wrappers these bars replaced did), without a blur flash. The input and the
            // clear button handle their own presses.
            onMouseDown={(event) => {
                if (event.target === inputRef.current || (event.target as Element).closest("button")) return;
                event.preventDefault();
            }}
            onClick={(event) => {
                if (event.target === inputRef.current || (event.target as Element).closest("button")) return;
                inputRef.current?.focus();
            }}
        >
            <SearchIcon className="mj_SearchField_icon" aria-hidden="true" />
            <input
                ref={inputRef}
                id={id}
                className="mj_SearchField_input"
                type="search"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    // An Escape that cancels an IME candidate is the input method's, not a clear.
                    if (event.key !== "Escape" || !value || isImeComposing(event)) return;
                    // Own this press: clear, and keep it from closing a pane or leaving a subagent.
                    event.preventDefault();
                    event.stopPropagation();
                    clear();
                }}
                placeholder={placeholder}
                aria-label={label}
                autoComplete="off"
                maxLength={maxLength}
            />
            {value ? (
                <button
                    type="button"
                    className="mj_SearchField_clear"
                    aria-label="Clear search"
                    // Keep focus in the field on a mouse press; the click then clears.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={clear}
                >
                    <CloseIcon aria-hidden="true" />
                </button>
            ) : null}
        </div>
    );
}
