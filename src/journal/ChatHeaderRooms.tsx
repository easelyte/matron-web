/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Two chat-header controls after the Mac's toolbar:
 *
 * - "Rooms · n" (RoomsControl): every agent-chat room this conversation takes part in, newest
 *   activity first (conversation-rooms.ts), each with its run state, its other participants,
 *   its last activity and a bell-slash when its notifications are off. Picking one opens it.
 *   Hidden for a chat that is in no room.
 * - The bell (ConvoNotifyBell): this conversation's notification level — All, Needs me, None,
 *   or Default to follow the mode — and a mute for 1 h, 8 h or until tomorrow 08:00. It turns
 *   into a bell-slash while nothing from the conversation notifies. Saved on the journal
 *   (PUT /notify), so the phone and the Mac follow it too. Hidden on a journal without
 *   notification settings.
 */

import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { MatronJournalClient } from "./client";
import {
    ROOM_STATE_LABEL,
    roomsAccessibilityLabel,
    roomsLabel,
    roomsOf,
    type ConversationRoom,
} from "./conversation-rooms";
import { BellIcon, BellSlashIcon, CheckIcon } from "./icons";
import {
    convoNotifyState,
    muteTime,
    NOTIFY_CONVO_LEVEL_TITLES,
    NOTIFY_DEFAULT_LEVEL_TITLE,
    NOTIFY_MUTE_DURATIONS,
    NOTIFY_MUTE_TITLES,
    notificationsFor,
    type NotifyConvoLevel,
} from "./notifications";
import { TaggedTitle } from "./SessionTag";
import { formatRelativeTime } from "./tracker/format";
import type { ClientState, Conversation } from "./types";
import { useDismissablePopover } from "./use-dismissable-popover";

/** Arrow keys walk the menu's items, Home and End jump to the ends; Escape closes it and gives focus back to the opener. */
function onMenuKeyDown(
    event: React.KeyboardEvent<HTMLElement>,
    close: () => void,
    openerRef: React.RefObject<HTMLButtonElement | null>,
): void {
    const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    );
    const index = items.findIndex((item) => item === document.activeElement);
    if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
        items[next]?.focus();
    } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        openerRef.current?.focus();
    }
}

/** A click-opened header menu: its opener, and its panel while open. */
function useHeaderMenu(): {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    close: () => void;
    openerRef: React.RefObject<HTMLButtonElement | null>;
    panelRef: React.RefObject<HTMLDivElement | null>;
} {
    const [open, setOpen] = useState(false);
    const openerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismissablePopover(open, close, { openerRef, panelRef });
    useLayoutEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')?.focus();
    }, [open]);
    return { open, setOpen, close, openerRef, panelRef };
}

/** What a screen reader reads for a room row: the button's label replaces its content, so the
 *  muted mark and the time go in here too. The peers line stays as its description. */
function roomRowLabel(room: ConversationRoom, silenced: boolean, now: number): string {
    const parts = [ROOM_STATE_LABEL[room.state], room.title];
    if (silenced) parts.push("notifications off");
    if (room.lastActivity !== undefined) parts.push(formatRelativeTime(room.lastActivity, now));
    return parts.join(", ");
}

function hasPeers(room: ConversationRoom): boolean {
    return room.peers.length > 0 || room.unknownPeers > 0;
}

function RoomPeers({
    id,
    room,
    state,
}: {
    id: string;
    room: ConversationRoom;
    state: ClientState;
}): React.ReactElement | null {
    if (!hasPeers(room)) return null;
    return (
        <span id={id} className="mj_RoomsMenu_peers">
            with{" "}
            {room.peers.map((peer: Conversation, index) => (
                <React.Fragment key={peer.id}>
                    {index > 0 && ", "}
                    <span className="mj_RoomsMenu_peer">
                        <TaggedTitle conversation={peer} agents={state.agents} />
                    </span>
                </React.Fragment>
            ))}
            {room.unknownPeers > 0 &&
                `${room.peers.length > 0 ? " and " : ""}${room.unknownPeers} other${room.unknownPeers === 1 ? "" : "s"}`}
        </span>
    );
}

/** The rooms one conversation takes part in, newest activity first. */
export function useConversationRooms(state: ClientState, convoId: string): ConversationRoom[] {
    return useMemo(() => roomsOf(convoId, state.conversations), [convoId, state.conversations]);
}

/**
 * The rooms list's rows: the Rooms menu's content, and the ⋯ menu's Rooms section when the
 * header is too narrow for the control. `onPick` runs the choice (closing the menu first).
 */
export function RoomsMenuItems({
    client,
    state,
    rooms,
    onPick,
}: {
    client: MatronJournalClient;
    state: ClientState;
    rooms: readonly ConversationRoom[];
    onPick: (run: () => void) => void;
}): React.ReactElement {
    const notifier = notificationsFor(client);
    const settings = useSyncExternalStore(notifier.subscribeSettings, notifier.getSettingsSnapshot);
    const idPrefix = useId();
    const now = Date.now();
    return (
        <>
            {rooms.map((room, index) => {
                const peersId = `${idPrefix}-peers-${index}`;
                const silenced = convoNotifyState(settings.view, room.id, settings.now).silenced;
                return (
                    <button
                        key={room.id}
                        type="button"
                        role="menuitem"
                        className="mj_RoomsMenu_item"
                        aria-label={roomRowLabel(room, silenced, now)}
                        aria-describedby={hasPeers(room) ? peersId : undefined}
                        onClick={() => onPick(() => void client.selectConversation(room.id))}
                    >
                        <span className="mj_RoomsMenu_head">
                            <span
                                className={`mj_HeaderStatusDot mj_RoomsMenu_dot mj_RoomsMenu_dot_${room.state}`}
                                aria-hidden="true"
                            />
                            <span className="mj_RoomsMenu_title">{room.title}</span>
                            {silenced && <BellSlashIcon className="mj_RoomsMenu_muted" aria-hidden />}
                            {room.lastActivity !== undefined && (
                                <span className="mj_RoomsMenu_time">{formatRelativeTime(room.lastActivity, now)}</span>
                            )}
                        </span>
                        <RoomPeers id={peersId} room={room} state={state} />
                    </button>
                );
            })}
        </>
    );
}

export function RoomsControl({
    client,
    state,
    conversation,
}: {
    client: MatronJournalClient;
    state: ClientState;
    conversation: Conversation;
}): React.ReactElement | null {
    const rooms = useConversationRooms(state, conversation.id);
    const { open, setOpen, close, openerRef, panelRef } = useHeaderMenu();
    const label = roomsLabel(rooms.length);
    if (!label) return null;
    return (
        <div
            className="mj_RoomsControl"
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
            }}
        >
            <button
                ref={openerRef}
                type="button"
                className="mj_RoomsControl_trigger"
                aria-label={roomsAccessibilityLabel(rooms.length)}
                title="Agent chat rooms this conversation is in"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
            >
                {label}
            </button>
            {open && (
                <div
                    ref={panelRef}
                    className="mj_HeaderMenu mj_RoomsMenu"
                    role="menu"
                    aria-label="Agent chat rooms"
                    onKeyDown={(event) => onMenuKeyDown(event, close, openerRef)}
                >
                    <RoomsMenuItems
                        client={client}
                        state={state}
                        rooms={rooms}
                        onPick={(run) => {
                            close();
                            run();
                        }}
                    />
                </div>
            )}
        </div>
    );
}

const NOTIFY_LEVELS: ReadonlyArray<[NotifyConvoLevel | null, string]> = [
    ["all", NOTIFY_CONVO_LEVEL_TITLES.all],
    ["needs_me", NOTIFY_CONVO_LEVEL_TITLES.needs_me],
    ["none", NOTIFY_CONVO_LEVEL_TITLES.none],
    [null, NOTIFY_DEFAULT_LEVEL_TITLE],
];

/**
 * The conversation's level and mute choices: the bell menu's content, and the ⋯ menu's
 * Notifications section when the header is too narrow for the bell. Nothing on a journal
 * without notification settings.
 */
export function NotifyMenuItems({
    client,
    convoId,
    onPick,
    levelLabel = "Level",
}: {
    client: MatronJournalClient;
    convoId: string;
    onPick: (run: () => void) => void;
    /** The heading over the level choices; the ⋯ menu names the whole section by it. */
    levelLabel?: string;
}): React.ReactElement | null {
    const notifier = notificationsFor(client);
    const settings = useSyncExternalStore(notifier.subscribeSettings, notifier.getSettingsSnapshot);
    if (!settings.view) return null;
    const convo = convoNotifyState(settings.view, convoId, settings.now);
    const pick = (run: () => Promise<void>): void => onPick(() => void run());
    return (
        <>
            <div className="mj_NotifyMenu_group" role="group" aria-label={levelLabel}>
                <div className="mj_NotifyMenu_label" aria-hidden="true">
                    {levelLabel}
                </div>
                {NOTIFY_LEVELS.map(([level, title]) => (
                    <button
                        key={level ?? "default"}
                        type="button"
                        role="menuitemradio"
                        aria-checked={convo.level === level}
                        className="mj_NotifyMenu_item"
                        data-level={level ?? "default"}
                        onClick={() => pick(() => notifier.setConvoLevel(convoId, level))}
                    >
                        <span className="mj_NotifyMenu_check" aria-hidden="true">
                            {convo.level === level && <CheckIcon />}
                        </span>
                        {title}
                    </button>
                ))}
            </div>
            <div className="mj_NotifyMenu_group" role="group" aria-label="Mute">
                {convo.mutedUntil !== null && (
                    <button
                        type="button"
                        role="menuitem"
                        className="mj_NotifyMenu_item"
                        data-mute="unmute"
                        onClick={() => pick(() => notifier.unmuteConvo(convoId))}
                    >
                        <span className="mj_NotifyMenu_check" aria-hidden="true" />
                        Unmute (muted until {muteTime(convo.mutedUntil, settings.now)})
                    </button>
                )}
                {NOTIFY_MUTE_DURATIONS.map((duration) => (
                    <button
                        key={duration}
                        type="button"
                        role="menuitem"
                        className="mj_NotifyMenu_item"
                        data-mute={duration}
                        onClick={() => pick(() => notifier.muteConvo(convoId, duration))}
                    >
                        <span className="mj_NotifyMenu_check" aria-hidden="true" />
                        {NOTIFY_MUTE_TITLES[duration]}
                    </button>
                ))}
            </div>
            {settings.error && (
                <p className="mj_NotifyMenu_error" role="alert">
                    {settings.error}
                </p>
            )}
        </>
    );
}

export function ConvoNotifyBell({
    client,
    convoId,
    onlyWhenSilenced = false,
}: {
    client: MatronJournalClient;
    convoId: string;
    /** On a narrow header the bell lives in the ⋯ menu; a silenced chat still shows its
     *  bell-slash here, so the header never hides that nothing from it notifies. */
    onlyWhenSilenced?: boolean;
}): React.ReactElement | null {
    const notifier = notificationsFor(client);
    const settings = useSyncExternalStore(notifier.subscribeSettings, notifier.getSettingsSnapshot);
    const { open, setOpen, close, openerRef, panelRef } = useHeaderMenu();
    if (!settings.view) return null;
    const silenced = convoNotifyState(settings.view, convoId, settings.now).silenced;
    if (onlyWhenSilenced && !silenced && !open) return null;
    const label = silenced ? "Notifications off for this conversation" : "Notifications";
    return (
        <div
            className="mj_NotifyBell"
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
            }}
        >
            <button
                ref={openerRef}
                type="button"
                className={`mj_IconButton mj_NotifyBell_trigger${silenced ? " mj_NotifyBell_trigger_silenced" : ""}`}
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
            >
                {silenced ? <BellSlashIcon aria-hidden /> : <BellIcon aria-hidden />}
            </button>
            {open && (
                <div
                    ref={panelRef}
                    className="mj_HeaderMenu mj_NotifyMenu"
                    role="menu"
                    aria-label="Notifications"
                    onKeyDown={(event) => onMenuKeyDown(event, close, openerRef)}
                >
                    <NotifyMenuItems
                        client={client}
                        convoId={convoId}
                        onPick={(run) => {
                            close();
                            const opener = openerRef.current;
                            opener?.focus();
                            const controls = opener?.closest(".mj_HeaderControls");
                            run();
                            // A narrow header drops the bell once the chat notifies again: focus
                            // goes to the ⋯ button, which now holds the choices.
                            if (onlyWhenSilenced) {
                                requestAnimationFrame(() => {
                                    if (!opener?.isConnected) {
                                        controls?.querySelector<HTMLElement>(".mj_HeaderOverflowTrigger")?.focus();
                                    }
                                });
                            }
                        }}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * The ⋯ menu's extra sections while the header is too narrow for Rooms and the bell: the
 * rooms list and the notification choices, each under its own label, then a separator before
 * the conversation actions. Nothing when neither applies.
 */
export function OverflowRoomsAndNotify({
    client,
    state,
    conversation,
    onPick,
}: {
    client: MatronJournalClient;
    state: ClientState;
    conversation: Conversation;
    onPick: (run: () => void) => void;
}): React.ReactElement | null {
    const rooms = useConversationRooms(state, conversation.id);
    const notifier = notificationsFor(client);
    const settings = useSyncExternalStore(notifier.subscribeSettings, notifier.getSettingsSnapshot);
    const roomsTitle = roomsLabel(rooms.length);
    const showNotify = Boolean(settings.view);
    if (!roomsTitle && !showNotify) return null;
    return (
        <>
            {roomsTitle && (
                <div className="mj_RoomsMenu mj_OverflowSection" role="group" aria-label="Agent chat rooms">
                    <div className="mj_OverflowSection_label" aria-hidden="true">
                        {roomsTitle}
                    </div>
                    <RoomsMenuItems client={client} state={state} rooms={rooms} onPick={onPick} />
                </div>
            )}
            {showNotify && (
                // Its own groups (named "Notifications" and "Mute") label it.
                <div className="mj_NotifyMenu mj_OverflowSection">
                    <NotifyMenuItems
                        client={client}
                        convoId={conversation.id}
                        onPick={onPick}
                        levelLabel="Notifications"
                    />
                </div>
            )}
            <div className="mj_OverflowSection_separator" role="separator" />
        </>
    );
}
