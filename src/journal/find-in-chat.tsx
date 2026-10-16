/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Find in chat: a search bar over the open conversation. Ctrl/⌘F opens it while a conversation is
// on screen (elsewhere the browser's own find keeps the key). Enter searches; with the query
// unchanged, Enter steps to the next older match and Shift+Enter back to a newer one. The journal
// searches the whole conversation, and each step rides the jump-to-message machinery, so a match
// far back in history pages it in before landing.

import React, { useEffect, useRef, useState } from "react";

import type { MatronJournalClient } from "./client";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from "./icons";
import { isMacPlatform, modalDialogOpen } from "./jump-to-message";
import type { ChatSearchState } from "./types";

/** True for the shortcut that opens the bar: ⌘F on a Mac, Ctrl+F elsewhere. */
export function isFindInChatShortcut(
    event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
    mac: boolean,
): boolean {
    if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return false;
    return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Binds Ctrl/⌘F to the bar while `enabled` (a conversation is on screen) and no modal dialog is up.
 * With it off the key is left alone, so the browser's find works on every other page.
 */
export function useFindInChatShortcut(client: MatronJournalClient, enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return undefined;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.isComposing || !isFindInChatShortcut(event, isMacPlatform())) return;
            // Under a modal dialog the conversation is not what the reader is looking at: the
            // browser's find keeps the key rather than the bar opening (and taking focus) behind it.
            if (modalDialogOpen()) return;
            event.preventDefault();
            client.openChatSearch();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [client, enabled]);
}

/** The bar's "3 of 12" / "No matches" verdict; empty while nothing has been searched yet. */
export function findPositionLabel(search: ChatSearchState): string {
    if (!search.query) return "";
    if (search.loading) return "Searching…";
    if (search.matchSeqs.length === 0) return search.failed ? "Search unavailable" : "No matches";
    return `${search.index + 1} of ${search.matchSeqs.length}`;
}

export function FindInChatBar({
    client,
    search,
}: {
    client: MatronJournalClient;
    search: ChatSearchState;
}): React.ReactElement {
    const [text, setText] = useState(search.query);
    const input = useRef<HTMLInputElement>(null);

    // A new search handed over from outside (a sidebar result) replaces what the field shows.
    useEffect(() => setText(search.query), [search.query]);

    // Ctrl/⌘F asks for the field, also when the bar is already up. A bar opened by a sidebar
    // result (focusTick 0) leaves focus where it is.
    useEffect(() => {
        if (search.focusTick === 0) return;
        input.current?.focus();
        input.current?.select();
    }, [search.focusTick]);

    const close = (): void => {
        client.endChatSearch();
        document.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input")?.focus();
    };
    const submitted = text.replace(/^\s+/, "") === search.query && !search.failed;
    const canOlder = !search.loading && search.index + 1 < search.matchSeqs.length;
    const canNewer = !search.loading && search.index > 0;

    return (
        <div
            className="mj_FindInChat"
            role="search"
            aria-label="Find in chat"
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                close();
            }}
        >
            <SearchIcon className="mj_FindInChat_glyph" aria-hidden />
            <input
                ref={input}
                className="mj_FindInChat_input"
                type="text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    if (submitted && search.query) void client.stepChatSearch(!event.shiftKey);
                    else void client.beginChatSearch(text);
                }}
                placeholder="Search in chat"
                aria-label="Search in chat"
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
            />
            <span className="mj_FindInChat_position" role="status" aria-live="polite">
                {findPositionLabel(search)}
            </span>
            <button
                type="button"
                className="mj_FindInChat_button"
                aria-label="Older match"
                title="Older match (Enter)"
                disabled={!canOlder}
                onClick={() => void client.stepChatSearch(true)}
            >
                <ChevronUpIcon aria-hidden />
            </button>
            <button
                type="button"
                className="mj_FindInChat_button"
                aria-label="Newer match"
                title="Newer match (Shift+Enter)"
                disabled={!canNewer}
                onClick={() => void client.stepChatSearch(false)}
            >
                <ChevronDownIcon aria-hidden />
            </button>
            <button
                type="button"
                className="mj_FindInChat_button"
                aria-label="Close search"
                title="Done (Esc)"
                onClick={close}
            >
                <CloseIcon aria-hidden />
            </button>
        </div>
    );
}
