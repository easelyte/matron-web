/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The app's keyboard shortcuts, after the Mac app's menu commands (Commands.swift) and its
 * hidden-button shortcuts in the chat view. ⌘ on a Mac, Ctrl elsewhere:
 *
 *   ⌘K      the slash-command palette for the open conversation (Edit ▸ Slash Command)
 *   ⌘N      a new session (File ▸ New Chat)
 *   ⌘1…⌘5   Coordinator, Projects, For you, Conversations, Memories (View menu, top to bottom)
 *   ⇧⌘F     the sidebar's search field (Edit ▸ Search All Chats), on Conversations only
 *   ⇧⌘U     jump to my last message in the open conversation (client.jumpToLastOwnMessage,
 *           which loads older history until it finds one)
 *
 * ⌘J (go to number) lives in goto-number.tsx and ⌘F (find in chat) with the chat search. Like the
 * Mac's menu key equivalents these fire from a text field too, except ⇧⌘U off a Mac: Ctrl+Shift+U
 * types a Unicode character in a Linux text field, so a field keeps it there.
 *
 * Shortcuts whose handler lives in a component that owns the state (the sidebar's new-session
 * sheet and its search field) go out on a small command bus, the Mac's NotificationCenter
 * shape: the component that is mounted listens with useShortcutCommand.
 */

import { useEffect, useRef } from "react";

import type { MatronJournalClient } from "./client";
import { isJumpToLastOwnShortcut, isMacPlatform, modalDialogOpen } from "./jump-to-message";

export type Section = "coordinator" | "projects" | "decisions" | "conversations" | "memories";

/** ⌘1 … ⌘5, the Mac's nav column top to bottom. */
export const SECTION_KEYS: ReadonlyArray<{ key: string; section: Section }> = [
    { key: "1", section: "coordinator" },
    { key: "2", section: "projects" },
    { key: "3", section: "decisions" },
    { key: "4", section: "conversations" },
    { key: "5", section: "memories" },
];

export type ShortcutCommand =
    | { kind: "commandPalette" }
    | { kind: "newSession" }
    | { kind: "searchAllChats" }
    | { kind: "jumpToLastOwnMessage" }
    | { kind: "section"; section: Section };

type ShortcutKey = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export { isMacPlatform };

/** The shortcut a keystroke names, or null. `mac` picks ⌘ over Ctrl as the modifier. */
export function matchShortcut(event: ShortcutKey, mac: boolean): ShortcutCommand | null {
    if (isJumpToLastOwnShortcut(event, mac)) return { kind: "jumpToLastOwnMessage" };
    if (event.altKey) return null;
    const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!primary) return null;
    const key = event.key.toLowerCase();
    if (event.shiftKey) {
        if (key === "f") return { kind: "searchAllChats" };
        return null;
    }
    if (key === "k") return { kind: "commandPalette" };
    if (key === "n") return { kind: "newSession" };
    const section = SECTION_KEYS.find((entry) => entry.key === key)?.section;
    return section ? { kind: "section", section } : null;
}

/** A shortcut's name for a tooltip: "⌘N" on a Mac, "Ctrl+N" elsewhere. */
export function shortcutLabel(key: string, { shift = false, mac = isMacPlatform() } = {}): string {
    const upper = key.toUpperCase();
    if (mac) return `${shift ? "⇧" : ""}⌘${upper}`;
    return `Ctrl+${shift ? "Shift+" : ""}${upper}`;
}

const isTextField = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT");

// ── Command bus ──

type BusCommand = "newSession" | "searchAllChats";
const bus = new EventTarget();

export function dispatchShortcutCommand(command: BusCommand): void {
    bus.dispatchEvent(new Event(command));
}

/** Runs `handler` for every `command` while the calling component is mounted. */
export function useShortcutCommand(command: BusCommand, handler: () => void): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    useEffect(() => {
        const listener = (): void => handlerRef.current();
        bus.addEventListener(command, listener);
        return () => bus.removeEventListener(command, listener);
    }, [command]);
}

// ── Actions ──

const TRACKER_VIEW = { projects: "missions", decisions: "inbox", memories: "memories" } as const;
let sectionSeq = 0;

/**
 * The rail's own routing: a section opens on its home, not a page left open inside it. The
 * Coordinator has no rail entry here; ⌘1 opens its conversation when the journal names one.
 */
export function showSection(client: MatronJournalClient, section: Section): Promise<void> {
    // A later section shortcut wins over a Coordinator lookup still in flight, and so does any
    // other navigation meanwhile (the rail, a conversation row, a search hit).
    const seq = ++sectionSeq;
    if (section === "coordinator") {
        const { selectedConversationId, trackerView } = client.getSnapshot();
        return client.coordinatorConversationId().then((convoId) => {
            const now = client.getSnapshot();
            const moved = now.selectedConversationId !== selectedConversationId || now.trackerView !== trackerView;
            if (convoId && seq === sectionSeq && !moved) {
                void client.selectConversation(convoId, { suppressNotFound: true });
            }
        });
    }
    if (section === "conversations") client.closeTrackerView();
    else
        client.openTrackerView({
            view: TRACKER_VIEW[section],
            projectId: null,
            missionId: null,
            itemId: null,
            memoryName: null,
        });
    return Promise.resolve();
}

export interface AppShortcutHandlers {
    /** False while a modal holds the app (the upload sheet): no shortcut fires. */
    enabled: boolean;
    /** ⌘K: toggles the palette. Unset when no conversation with a composer is open. */
    onCommandPalette?: () => void;
}

/** Binds the app-wide shortcuts on the document for as long as the signed-in app is mounted. */
export function useAppShortcuts(client: MatronJournalClient, handlers: AppShortcutHandlers): void {
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;
    const { enabled } = handlers;
    useEffect(() => {
        if (!enabled) return undefined;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.isComposing) return;
            const mac = isMacPlatform();
            const command = matchShortcut(event, mac);
            if (!command) return;
            if (command.kind === "jumpToLastOwnMessage" && !mac && isTextField(event.target)) return;
            // Another sheet or dialog is up: it owns the keyboard. The palette closes itself on ⌘K.
            if (modalDialogOpen()) return;
            // A held key repeats: one press, one action (⌘K would otherwise flicker open and shut),
            // but the repeats are still ours, not the browser's (tab switching, its search bar).
            if (event.repeat) {
                if (command.kind !== "commandPalette" || handlersRef.current.onCommandPalette) event.preventDefault();
                return;
            }
            switch (command.kind) {
                case "commandPalette": {
                    const open = handlersRef.current.onCommandPalette;
                    if (!open) return;
                    event.preventDefault();
                    open();
                    return;
                }
                case "newSession":
                case "searchAllChats":
                    event.preventDefault();
                    dispatchShortcutCommand(command.kind);
                    return;
                case "jumpToLastOwnMessage":
                    // The client pages older history back until it finds one (jump-to-message.ts).
                    event.preventDefault();
                    void client.jumpToLastOwnMessage();
                    return;
                case "section":
                    event.preventDefault();
                    void showSection(client, command.section);
                    return;
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [client, enabled]);
}
