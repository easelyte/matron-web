/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * ⇧⌘K: the open conversation's slash commands without typing "/" first — the Mac's pinned-open
 * slash palette (ComposerViewModel.palettePinnedOpen). Same rows as the composer's palette; the
 * sheet has its own filter field, so the draft is left alone until a command is picked, and the
 * pick replaces it with the command's trigger and a space, ready for arguments, as on the Mac.
 * ⇧⌘K again, Escape or a click outside closes it.
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useSheetLifecycle } from "./PinDialogs";
import { isMacPlatform, matchShortcut } from "./shortcuts";
import { type BotCommand, CLAUDE_BRIDGE_COMMANDS, filterCommands } from "./slash-palette";

const LISTBOX_ID = "mj_CommandPalette_listbox";
const rowId = (index: number): string => `${LISTBOX_ID}_opt_${index}`;

export function CommandPalette({
    commands = CLAUDE_BRIDGE_COMMANDS,
    onPick,
    onClose,
}: {
    commands?: BotCommand[];
    onPick: (command: BotCommand) => void;
    onClose: () => void;
}): React.ReactElement {
    useSheetLifecycle(onClose);
    const [query, setQuery] = useState("");
    const [highlighted, setHighlighted] = useState(0);
    const highlightedRow = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const rows = filterCommands(commands, query);
    const active = rows.length > 0 ? Math.min(highlighted, rows.length - 1) : null;

    useEffect(() => {
        highlightedRow.current?.scrollIntoView?.({ block: "nearest" });
    }, [active]);

    // Focus goes back where it was when the palette closes without a pick (a pick moves it to the
    // composer itself, a frame later). Read at first render, before the field's autoFocus.
    const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    useEffect(() => {
        return () => {
            if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [opener]);

    // ⇧⌘K closes it wherever focus has gone (the app's own handler stands aside while a dialog is up).
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.repeat) {
                if (matchShortcut(event, isMacPlatform())?.kind === "commandPalette") event.preventDefault();
                return;
            }
            if (event.defaultPrevented || matchShortcut(event, isMacPlatform())?.kind !== "commandPalette") return;
            event.preventDefault();
            onCloseRef.current();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            if (active !== null) setHighlighted(Math.min(active + 1, rows.length - 1));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (active !== null) setHighlighted(Math.max(active - 1, 0));
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (active !== null) onPick(rows[active]);
        } else if (event.key === "Tab") {
            // The field is the sheet's only stop (rows are picked by arrow keys): keep focus in it.
            event.preventDefault();
        }
    };

    return createPortal(
        <div
            className="mj_UploadConfirm_scrim mj_CommandPalette_scrim"
            role="dialog"
            aria-modal="true"
            aria-label="Slash commands"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            {/* A click on the sheet's padding keeps focus in the field. */}
            <div
                className="mj_CommandPalette"
                onMouseDown={(event) => {
                    if (event.target !== inputRef.current) event.preventDefault();
                }}
            >
                <input
                    className="mj_CommandPalette_input"
                    type="text"
                    ref={inputRef}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-label="Filter commands"
                    aria-expanded="true"
                    aria-controls={LISTBOX_ID}
                    aria-activedescendant={active !== null ? rowId(active) : undefined}
                    placeholder="Type a command"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setHighlighted(0);
                    }}
                    onKeyDown={onKeyDown}
                />
                <div className="mj_CommandPalette_list" id={LISTBOX_ID} role="listbox" aria-label="Commands">
                    {rows.map((command, index) => (
                        <div
                            key={command.trigger}
                            id={rowId(index)}
                            ref={index === active ? highlightedRow : undefined}
                            className={`mj_SlashPalette_row${index === active ? " mj_SlashPalette_row_highlighted" : ""}`}
                            role="option"
                            aria-selected={index === active}
                            onMouseEnter={() => setHighlighted(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onPick(command)}
                        >
                            <span className="mj_SlashPalette_trigger">{command.trigger}</span>
                            {command.argHint && <span className="mj_SlashPalette_argHint">{command.argHint}</span>}
                            <span className="mj_SlashPalette_summary">{command.summary}</span>
                        </div>
                    ))}
                </div>
                {rows.length === 0 && (
                    <p className="mj_CommandPalette_empty" role="status">
                        No command starts with “{query.trim()}”.
                    </p>
                )}
            </div>
        </div>,
        document.body,
    );
}
