/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Settings as the Mac app lays them out (unify step 6): a sheet, not a popover, with grouped
 * sections — Account (user, server, device) and Appearance (System / Light / Dark) — and Sign out.
 * The theme choice lives here now, as on the Mac, instead of a toggle in the chrome.
 * New chats holds the user's default model and effort (journal GET/PUT /defaults), which every
 * bridge applies to a chat started without a choice of its own.
 * Boxes holds each agent box's own defaults (journal PUT /devices/:id/defaults): the agent, model
 * and effort a session started there gets when nobody names them.
 * Security (TwoFactor.tsx): two-factor sign-in with an authenticator app — set up, new recovery
 * codes, move to a new app, turn off, and (admins) require it for everyone.
 * Devices (DevicesSettings.tsx) is the Mac's Devices tab: rename, tag and revoke each device, and
 * the Add Agent and Link a Device pairing flows.
 *
 * For you: the journal's per-user `notices` setting (agents file things to read as items with a
 * Seen button instead of leaving them in chat). The sheet asks the client to load it on open; the
 * switch is hidden until the value is known and on a journal without settings (GET /settings 404).
 *
 * Coordinator: the Coordinator conversation (`convo_id` on GET/PUT /coordinator) with Change…
 * and Clear, the journal's consent-approval switch (`consent`, hidden on a journal that does not
 * return it), and Routines…, as on the Mac.
 *
 * Notifications: desktop notifications in this browser while a tab is open (notifications.ts).
 * Turning them on asks the browser for permission, so it must happen on the click itself.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { MatronJournalClient } from "./client";
import { UsersSettings } from "./AccountEmail";
import { DevicesSettings } from "./DevicesSettings";
import { SecuritySettings } from "./TwoFactor";
import {
    activeOverrides,
    convoNotifyState,
    convoNotifySummary,
    type DesktopNotificationsState,
    NOTIFY_DEVICE_LEVEL_TITLES,
    NOTIFY_EVENT_TITLES,
    NOTIFY_EVENTS,
    NOTIFY_MODE_TITLES,
    notificationsFor,
    type NotifyDeviceLevel,
    type NotifyMode,
} from "./notifications";
import { displayTitle } from "./SessionTag";
import { useShowTheWork } from "./show-the-work";
import { getSnapshot, setTheme, subscribe, type ThemePref } from "./theme";
import type { BoxDefaults, BoxDefaultsState, DefaultsState, Session, UserDefaultKey } from "./types";
import { AUTO_ARCHIVE_CHOICES, autoArchiveLabel } from "./server-archive";

const APPEARANCE: ReadonlyArray<{ value: "system" | "light" | "dark"; label: string; pref: ThemePref }> = [
    { value: "system", label: "System", pref: null },
    { value: "light", label: "Light", pref: "light" },
    { value: "dark", label: "Dark", pref: "dark" },
];

type Choice = { value: string; label: string };

// "" is "Box default" (null on the wire): each bridge then uses its own MATRON_DEFAULT_* setting.
const BOX_DEFAULT = "";
// Shown, disabled, until the first GET /defaults answers (or after it failed).
const NOT_LOADED = "not-loaded";

const MODEL_CHOICES: ReadonlyArray<Choice> = [
    { value: BOX_DEFAULT, label: "Box default" },
    { value: "opus", label: "Opus" },
    { value: "opus[1m]", label: "Opus 1M" },
    { value: "sonnet", label: "Sonnet" },
    { value: "sonnet[1m]", label: "Sonnet 1M" },
    { value: "haiku", label: "Haiku" },
    { value: "opusplan", label: "Opus Plan" },
    { value: "fable", label: "Fable" },
];

const EFFORT_CHOICES: ReadonlyArray<Choice> = [
    { value: BOX_DEFAULT, label: "Box default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
    { value: "max", label: "Max" },
];

const DEFAULT_FIELDS: ReadonlyArray<{ key: UserDefaultKey; label: string; choices: ReadonlyArray<Choice> }> = [
    { key: "default_model", label: "Default model", choices: MODEL_CHOICES },
    { key: "default_effort", label: "Default effort", choices: EFFORT_CHOICES },
];

// ── Boxes ─────────────────────────────────────────────────────────────────────────────────────
// "" is null on the wire: the bridge's own fallback (its MATRON_DEFAULT_* setting).

const BOX_AGENT_CHOICES: ReadonlyArray<Choice> = [
    { value: BOX_DEFAULT, label: "Box default" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
];

// A box's model and effort belong to its default agent. With no agent set the box most likely
// runs Claude (the bridge's own fallback), so it gets the Claude lists.
const BOX_CLAUDE_MODEL_CHOICES: ReadonlyArray<Choice> = [
    { value: BOX_DEFAULT, label: "Default" },
    ...MODEL_CHOICES.slice(1),
];
const BOX_CLAUDE_EFFORT_CHOICES: ReadonlyArray<Choice> = [
    { value: BOX_DEFAULT, label: "Default" },
    ...EFFORT_CHOICES.slice(1),
];
// Codex has "minimal" and no "max" (the journal takes minimal…max for a box).
const BOX_CODEX_EFFORT_CHOICES: ReadonlyArray<Choice> = [
    { value: BOX_DEFAULT, label: "Default" },
    { value: "minimal", label: "Minimal" },
    ...EFFORT_CHOICES.slice(1).filter((choice) => choice.value !== "max"),
];

// A stored value outside the list (a full claude-* name another app or an agent wrote) is kept
// as an extra option under its own name, so the select shows what is really set.
function choicesFor(choices: ReadonlyArray<Choice>, stored: string | null): ReadonlyArray<Choice> {
    const selected = stored ?? BOX_DEFAULT;
    if (choices.some((choice) => choice.value === selected)) return choices;
    return [...choices, { value: selected, label: selected }];
}

function NewChatDefaults({ client }: { client: MatronJournalClient }): React.ReactElement {
    const defaults: DefaultsState | undefined = useSyncExternalStore(
        client.subscribe,
        () => client.getSnapshot().defaults,
    );

    useEffect(() => client.showDefaults(), [client]);

    const value = defaults?.value;
    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-new-chats">
            <h3 id="mj-settings-new-chats" className="mj_SettingsSheet_groupTitle">
                New chats
            </h3>
            {defaults?.unsupported ? (
                <p className="mj_SettingsSheet_help">This journal does not support default settings yet.</p>
            ) : (
                <>
                    <div className="mj_SettingsSheet_rows">
                        {DEFAULT_FIELDS.map((field) => {
                            const stored = value ? value[field.key] : undefined;
                            return (
                                <label key={field.key} className="mj_SettingsSheet_row">
                                    <span>{field.label}</span>
                                    <select
                                        className="mj_SettingsSheet_select"
                                        data-setting={field.key}
                                        value={stored === undefined ? NOT_LOADED : (stored ?? BOX_DEFAULT)}
                                        disabled={stored === undefined}
                                        onChange={(event) =>
                                            void client.setDefault(field.key, event.target.value || null)
                                        }
                                    >
                                        {stored === undefined ? (
                                            <option value={NOT_LOADED}>
                                                {defaults?.error ? "Unavailable" : "Loading…"}
                                            </option>
                                        ) : (
                                            choicesFor(field.choices, stored).map((choice) => (
                                                <option key={choice.value} value={choice.value}>
                                                    {choice.label}
                                                </option>
                                            ))
                                        )}
                                    </select>
                                </label>
                            );
                        })}
                    </div>
                    <p className="mj_SettingsSheet_help">
                        Used when a new chat starts without a choice of its own. Box default uses each box&apos;s
                        setting.
                    </p>
                    {defaults?.error && (
                        <p className="mj_SettingsSheet_error" role="alert">
                            {defaults.error}
                        </p>
                    )}
                </>
            )}
        </section>
    );
}

// The Codex model is free text (Codex ids are open-ended): saved on Enter or on leaving the field,
// trimmed, and an empty field is "Codex default" (null). The draft follows the stored value.
function CodexModelInput({
    stored,
    onSave,
}: {
    stored: string | null;
    onSave: (value: string | null) => void;
}): React.ReactElement {
    const [draft, setDraft] = useState(stored ?? "");
    useEffect(() => setDraft(stored ?? ""), [stored]);
    const commit = (): void => {
        const value = draft.trim() || null;
        if (value !== stored) onSave(value);
    };
    return (
        <input
            className="mj_SettingsSheet_select mj_SettingsSheet_input"
            data-box-setting="model"
            type="text"
            value={draft}
            placeholder="Codex default"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                }
            }}
        />
    );
}

function BoxDefaultsRows({
    client,
    deviceId,
    defaults,
}: {
    client: MatronJournalClient;
    deviceId: number;
    defaults: BoxDefaults;
}): React.ReactElement {
    const codex = defaults.agent === "codex";
    const efforts = codex ? BOX_CODEX_EFFORT_CHOICES : BOX_CLAUDE_EFFORT_CHOICES;
    const options = (choices: ReadonlyArray<Choice>, stored: string | null): React.ReactNode =>
        choicesFor(choices, stored).map((choice) => (
            <option key={choice.value} value={choice.value}>
                {choice.label}
            </option>
        ));
    return (
        <>
            <label className="mj_SettingsSheet_row">
                <span>Agent</span>
                <select
                    className="mj_SettingsSheet_select"
                    data-box-setting="agent"
                    value={defaults.agent ?? BOX_DEFAULT}
                    onChange={(event) =>
                        void client.setBoxDefaults(deviceId, { default_agent: event.target.value || null })
                    }
                >
                    {options(BOX_AGENT_CHOICES, defaults.agent)}
                </select>
            </label>
            <label className="mj_SettingsSheet_row">
                <span>Model</span>
                {codex ? (
                    <CodexModelInput
                        stored={defaults.model}
                        onSave={(value) => void client.setBoxDefaults(deviceId, { default_model: value })}
                    />
                ) : (
                    <select
                        className="mj_SettingsSheet_select"
                        data-box-setting="model"
                        value={defaults.model ?? BOX_DEFAULT}
                        onChange={(event) =>
                            void client.setBoxDefaults(deviceId, { default_model: event.target.value || null })
                        }
                    >
                        {options(BOX_CLAUDE_MODEL_CHOICES, defaults.model)}
                    </select>
                )}
            </label>
            <label className="mj_SettingsSheet_row">
                <span>Effort</span>
                <select
                    className="mj_SettingsSheet_select"
                    data-box-setting="effort"
                    value={defaults.effort ?? BOX_DEFAULT}
                    onChange={(event) =>
                        void client.setBoxDefaults(deviceId, { default_effort: event.target.value || null })
                    }
                >
                    {options(efforts, defaults.effort)}
                </select>
            </label>
        </>
    );
}

// Hidden on a journal without per-box defaults, and while there is no agent box to show and no
// error to say why (a failed load shows the group with its error).
function BoxesDefaults({ client }: { client: MatronJournalClient }): React.ReactElement | null {
    const state: BoxDefaultsState | undefined = useSyncExternalStore(
        client.subscribe,
        () => client.getSnapshot().boxDefaults,
    );

    useEffect(() => client.showBoxDefaults(), [client]);

    if (!state || state.unsupported || (state.boxes.length === 0 && !state.error)) return null;
    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-boxes">
            <h3 id="mj-settings-boxes" className="mj_SettingsSheet_groupTitle">
                Boxes
            </h3>
            {state.boxes.map((box) => (
                <div
                    key={box.device_id}
                    className="mj_SettingsSheet_rows mj_SettingsSheet_box"
                    data-box={box.device_id}
                >
                    <div className="mj_SettingsSheet_row mj_SettingsSheet_boxName">
                        {box.name ?? `Box ${box.device_id}`}
                    </div>
                    <BoxDefaultsRows client={client} deviceId={box.device_id} defaults={box.defaults} />
                </div>
            ))}
            <p className="mj_SettingsSheet_help">
                What a new session on each box runs when nobody names an agent, model or effort. Box default uses the
                box&apos;s own setting.
            </p>
            {state.error && (
                <p className="mj_SettingsSheet_error" role="alert">
                    {state.error}
                </p>
            )}
        </section>
    );
}

// Coordinator, as on the Mac: the Coordinator conversation with Change… and Clear (or Choose…
// when none is set), the journal's consent-approval switch, and Routines…. The conversation row
// shows once GET /coordinator answers; the switch is hidden on a journal without it. The chooser
// and the Routines sheet are the parent's to open: they replace this sheet while they show.
function CoordinatorSettings({
    client,
    onChooseCoordinator,
    onOpenRoutines,
}: {
    client: MatronJournalClient;
    onChooseCoordinator?: () => void;
    onOpenRoutines?: () => void;
}): React.ReactElement | null {
    const state = useSyncExternalStore(client.subscribe, () => client.getSnapshot().coordinatorConsent);
    const convoId = useSyncExternalStore(client.subscribe, () => client.getSnapshot().coordinatorConvoId);
    const conversations = useSyncExternalStore(client.subscribe, () => client.getSnapshot().conversations);
    const [saveError, setSaveError] = useState<string>();

    useEffect(() => void client.loadCoordinatorConsent(), [client]);

    const enabled = state?.enabled;
    const known = convoId !== undefined;
    if (enabled === undefined && !known) return null;
    const conversation = convoId ? conversations.find((candidate) => candidate.id === convoId) : undefined;
    const title = convoId ? (conversation ? displayTitle(conversation) : convoId) : undefined;
    const clear = async (): Promise<void> => {
        setSaveError(await client.setCoordinator(null));
    };
    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-coordinator">
            <h3 id="mj-settings-coordinator" className="mj_SettingsSheet_groupTitle">
                Coordinator
            </h3>
            <div className="mj_SettingsSheet_rows">
                {known && (
                    <div className="mj_SettingsSheet_row mj_SettingsSheet_coordinatorRow" data-setting="coordinator">
                        {title ? (
                            <>
                                <span className="mj_SettingsSheet_switchText">
                                    <span>Conversation</span>
                                    <span className="mj_SettingsSheet_help mj_SettingsSheet_coordinatorTitle">
                                        {title}
                                    </span>
                                </span>
                                <span className="mj_SettingsSheet_rowActions">
                                    {onChooseCoordinator && (
                                        <button
                                            type="button"
                                            className="mj_SettingsSheet_rowButton"
                                            onClick={onChooseCoordinator}
                                        >
                                            Change…
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="mj_SettingsSheet_rowButton mj_SettingsSheet_rowButton_critical"
                                        onClick={() => void clear()}
                                    >
                                        Clear
                                    </button>
                                </span>
                            </>
                        ) : (
                            <>
                                <span className="mj_SettingsSheet_help">No coordinator conversation yet.</span>
                                {onChooseCoordinator && (
                                    <button
                                        type="button"
                                        className="mj_SettingsSheet_rowButton"
                                        onClick={onChooseCoordinator}
                                    >
                                        Choose…
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
                {enabled !== undefined && (
                    <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                        <span className="mj_SettingsSheet_switchText">
                            <span id="mj-settings-coordinator-consent">
                                Let the Coordinator approve chats and spawns
                            </span>
                            <span id="mj-settings-coordinator-consent-help" className="mj_SettingsSheet_help">
                                Each request it answers says so on its card, with the reason.
                            </span>
                        </span>
                        <button
                            type="button"
                            role="switch"
                            className="mj_SettingsSheet_switch"
                            data-setting="coordinator-consent"
                            aria-checked={enabled}
                            aria-labelledby="mj-settings-coordinator-consent"
                            aria-describedby="mj-settings-coordinator-consent-help"
                            onClick={() => void client.setCoordinatorConsent(!enabled)}
                        />
                    </div>
                )}
                {onOpenRoutines && (
                    <div className="mj_SettingsSheet_row">
                        <span>Routines</span>
                        <button
                            type="button"
                            className="mj_SettingsSheet_rowButton"
                            data-setting="routines"
                            onClick={onOpenRoutines}
                        >
                            Routines…
                        </button>
                    </div>
                )}
            </div>
            {state?.error ? (
                <p className="mj_SettingsSheet_error" role="alert">
                    Couldn't save: {state.error}
                </p>
            ) : null}
            {saveError ? (
                <p className="mj_SettingsSheet_error" role="alert">
                    {saveError}
                </p>
            ) : null}
        </section>
    );
}

const PERMISSION_HELP: Record<DesktopNotificationsState["permission"], string> = {
    unsupported: "This browser can't show notifications.",
    default: "Your browser will ask to allow notifications from Matron.",
    granted: "Allowed in this browser.",
    denied: "Blocked in this browser. Allow notifications for this site in the browser's settings to turn them on.",
};

function DesktopNotifications({ client }: { client: MatronJournalClient }): React.ReactElement {
    const notifier = notificationsFor(client);
    const state = useSyncExternalStore(notifier.subscribe, notifier.getSnapshot);
    const blocked = state.permission === "unsupported" || state.permission === "denied";
    return (
        <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-notifications">
            <h3 id="mj-settings-notifications" className="mj_SettingsSheet_groupTitle">
                Notifications
            </h3>
            <div className="mj_SettingsSheet_rows">
                <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                    <span className="mj_SettingsSheet_switchText">
                        <span id="mj-settings-desktop-notifications">Desktop notifications</span>
                        <span
                            id="mj-settings-desktop-notifications-help"
                            className="mj_SettingsSheet_help"
                            data-permission={state.permission}
                        >
                            {PERMISSION_HELP[state.permission]}
                        </span>
                    </span>
                    <button
                        type="button"
                        role="switch"
                        className="mj_SettingsSheet_switch"
                        data-setting="desktop-notifications"
                        aria-checked={state.enabled}
                        aria-labelledby="mj-settings-desktop-notifications"
                        aria-describedby="mj-settings-desktop-notifications-help"
                        disabled={blocked}
                        onClick={() => (state.enabled ? notifier.disable() : void notifier.enable())}
                    />
                </div>
                <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                    <span className="mj_SettingsSheet_switchText">
                        <span id="mj-settings-notification-sound">Play sound</span>
                    </span>
                    <button
                        type="button"
                        role="switch"
                        className="mj_SettingsSheet_switch"
                        data-setting="notification-sound"
                        aria-checked={state.enabled && state.sound}
                        aria-labelledby="mj-settings-notification-sound"
                        disabled={!state.enabled}
                        onClick={() => notifier.setSound(!state.sound)}
                    />
                </div>
            </div>
            <p className="mj_SettingsSheet_help">
                Shown while Matron is open in a tab, for what your notification settings send to this device. Nothing
                shows for the conversation you are looking at.
            </p>
            <NotifySettingsRows client={client} />
        </section>
    );
}

const NOTIFY_MODES: readonly NotifyMode[] = ["coordinator", "all", "custom"];
const NOTIFY_DEVICE_LEVELS: readonly NotifyDeviceLevel[] = ["all", "needs_me", "off"];

/**
 * What may notify the user, as the Mac's Settings → Notifications edits it (journal GET/PUT
 * /notify): the mode, the event switches and the per-conversation overrides are synced per user,
 * so a change here reaches the phone and the Mac at once; "On this device" is this browser's own.
 * Every change shows at once and is taken back if the journal refuses it.
 */
function NotifySettingsRows({ client }: { client: MatronJournalClient }): React.ReactElement | null {
    const notifier = notificationsFor(client);
    const { view, error, now } = useSyncExternalStore(notifier.subscribeSettings, notifier.getSettingsSnapshot);
    const conversations = useSyncExternalStore(client.subscribe, () => client.getSnapshot().conversations);
    // On opening as well as on every connect: a change missed while the socket was down is caught here.
    useEffect(() => {
        void notifier.refreshSettings();
    }, [notifier]);

    if (view === null) {
        return <p className="mj_SettingsSheet_help">This server doesn't support notification settings yet.</p>;
    }
    if (view === undefined) {
        // Not read yet, or the read failed: a note, not an alert — nothing was lost.
        return error ? <p className="mj_SettingsSheet_help">{error}.</p> : null;
    }
    const overrides = activeOverrides(view, now);
    const titleOf = (convoId: string): string => {
        const conversation = conversations.find((candidate) => candidate.id === convoId);
        return conversation ? displayTitle(conversation) : convoId;
    };
    return (
        <>
            <h4 id="mj-settings-notify-mode" className="mj_SettingsSheet_groupTitle">
                Notify me about
            </h4>
            <div className="mj_SettingsSheet_rows" role="radiogroup" aria-labelledby="mj-settings-notify-mode">
                {NOTIFY_MODES.map((mode) => (
                    <label key={mode} className="mj_SettingsSheet_row mj_SettingsSheet_radioRow">
                        <input
                            type="radio"
                            name="mj-settings-notify-mode"
                            data-notify-mode={mode}
                            checked={view.mode === mode}
                            onChange={() => void notifier.changeSettings({ kind: "mode", mode })}
                        />
                        <span className="mj_SettingsSheet_switchText">
                            <span>{NOTIFY_MODE_TITLES[mode].title}</span>
                            <span className="mj_SettingsSheet_help">{NOTIFY_MODE_TITLES[mode].subtitle}</span>
                        </span>
                    </label>
                ))}
            </div>
            {view.mode === "coordinator" && !view.has_coordinator && (
                <p className="mj_SettingsSheet_help">
                    Until a Coordinator is set, Coordinator mode acts as Every session.
                </p>
            )}
            <h4 className="mj_SettingsSheet_groupTitle">Events</h4>
            <div className="mj_SettingsSheet_rows">
                {NOTIFY_EVENTS.map((event) => {
                    const id = `mj-settings-notify-event-${event}`;
                    const locked = event === "prompts";
                    return (
                        <div key={event} className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                            <span className="mj_SettingsSheet_switchText">
                                <span id={id}>{NOTIFY_EVENT_TITLES[event]}</span>
                                {locked && (
                                    <span className="mj_SettingsSheet_help">
                                        Always on: an unanswered prompt blocks an agent.
                                    </span>
                                )}
                            </span>
                            <button
                                type="button"
                                role="switch"
                                className="mj_SettingsSheet_switch"
                                data-notify-event={event}
                                aria-checked={locked || view.events[event]}
                                aria-labelledby={id}
                                disabled={locked}
                                onClick={() =>
                                    void notifier.changeSettings({ kind: "event", event, on: !view.events[event] })
                                }
                            />
                        </div>
                    );
                })}
            </div>
            {view.mode !== "custom" && <p className="mj_SettingsSheet_help">Changing a switch moves you to Custom.</p>}
            <div className="mj_SettingsSheet_rows">
                <label className="mj_SettingsSheet_row">
                    <span>On this device</span>
                    <select
                        className="mj_SettingsSheet_select"
                        data-setting="notify-device-level"
                        value={view.device_level}
                        onChange={(event) =>
                            void notifier.changeSettings({
                                kind: "device_level",
                                level: event.target.value as NotifyDeviceLevel,
                            })
                        }
                    >
                        {NOTIFY_DEVICE_LEVELS.map((level) => (
                            <option key={level} value={level}>
                                {NOTIFY_DEVICE_LEVEL_TITLES[level]}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {overrides.length > 0 && (
                <>
                    <h4 className="mj_SettingsSheet_groupTitle">Conversation overrides</h4>
                    <div className="mj_SettingsSheet_rows">
                        {overrides.map((row) => (
                            <div
                                key={row.convo_id}
                                className="mj_SettingsSheet_row mj_SettingsSheet_switchRow"
                                data-notify-override={row.convo_id}
                            >
                                <span className="mj_SettingsSheet_switchText">
                                    <span className="mj_SettingsSheet_overrideTitle">{titleOf(row.convo_id)}</span>
                                    <span className="mj_SettingsSheet_help">
                                        {convoNotifySummary(convoNotifyState(view, row.convo_id, now), now)}
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    className="mj_SettingsSheet_clear"
                                    aria-label={`Clear the override for ${titleOf(row.convo_id)}`}
                                    onClick={() =>
                                        void notifier.changeSettings({ kind: "clear_convo", convoId: row.convo_id })
                                    }
                                >
                                    Clear
                                </button>
                            </div>
                        ))}
                    </div>
                </>
            )}
            <p className="mj_SettingsSheet_help">
                Events that don't notify still update the lists and unread dots. Each conversation's own level and mute
                are in the bell menu in its header.
            </p>
            {error && (
                <p className="mj_SettingsSheet_error" role="alert">
                    {error}
                </p>
            )}
        </>
    );
}

export function SettingsSheet({
    client,
    session,
    connection,
    notices,
    noticesError,
    autoApproveCoordinatorSpawns,
    onAutoApproveCoordinatorSpawnsChange,
    autoArchiveDays,
    autoArchiveError,
    onAutoArchiveChange,
    onLoadSettings,
    onNoticesChange,
    onChooseCoordinator,
    onOpenRoutines,
    onSignOut,
    onClose,
}: {
    client: MatronJournalClient;
    session?: Session;
    connection: string;
    /** The notices setting; undefined hides the switch (not known yet, or an older journal). */
    notices?: boolean;
    /** Undefined hides the switch on an older journal. */
    autoApproveCoordinatorSpawns?: boolean;
    onAutoApproveCoordinatorSpawnsChange?: (enabled: boolean) => void;
    /** The last failed save of the setting. */
    noticesError?: string;
    /** Days before an idle chat is archived (0 = off); undefined hides the row (an older journal). */
    autoArchiveDays?: number;
    /** The last failed save of the auto-archive setting. */
    autoArchiveError?: string;
    onAutoArchiveChange?: (days: number) => void;
    /** Fetch the settings (on open). */
    onLoadSettings?: () => void;
    onNoticesChange?: (notices: boolean) => void;
    /** Settings → Coordinator → Change… / Choose…: the parent opens the chooser in this sheet's place. */
    onChooseCoordinator?: () => void;
    /** Settings → Coordinator → Routines…: the parent opens the Routines sheet in this sheet's place. */
    onOpenRoutines?: () => void;
    onSignOut: () => void;
    onClose: () => void;
}): React.ReactElement {
    const preference = useSyncExternalStore(subscribe, getSnapshot);
    const [developerView, setDeveloperView] = useShowTheWork();
    const sheetRef = useRef<HTMLDivElement>(null);
    // The latest onClose without re-running the focus effect when a caller passes a new function.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const pressStartedOnScrim = useRef(false);
    const onLoadSettingsRef = useRef(onLoadSettings);
    onLoadSettingsRef.current = onLoadSettings;
    // Bumped by a password change, so Devices re-reads a roster that may have lost devices.
    const [devicesRevision, setDevicesRevision] = useState(0);

    useEffect(() => {
        onLoadSettingsRef.current?.();
    }, []);

    useEffect(() => {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        sheetRef.current?.focus();
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== "Tab") return;
            // A modal: Tab cycles inside the sheet (same pattern as the event-source sheet).
            const focusable = [
                ...(sheetRef.current?.querySelectorAll<HTMLElement>(
                    "button:not([disabled]), select:not([disabled]), input:not([disabled])",
                ) ?? []),
            ];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            // On the dialog itself (where focus lands on open, or after a click on the sheet chrome)
            // counts as outside the controls: either direction would otherwise step out of the sheet.
            const onButton = focusable.includes(document.activeElement as HTMLElement);
            if (event.shiftKey && (document.activeElement === first || !onButton)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !onButton)) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            if (opener?.isConnected) opener.focus();
        };
    }, []);

    const connectionLabel =
        connection === "online" ? "Connected" : connection === "connecting" ? "Connecting…" : "Offline";

    return (
        <div
            className="mj_SettingsScrim"
            // Close only on a press that began on the scrim, so a text-selection drag out of the
            // sheet does not dismiss it.
            onPointerDown={(event) => {
                pressStartedOnScrim.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget && pressStartedOnScrim.current) onClose();
            }}
        >
            <div
                ref={sheetRef}
                className="mj_SettingsSheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mj-settings-title"
                tabIndex={-1}
            >
                <header className="mj_SettingsSheet_head">
                    <h2 id="mj-settings-title">Settings</h2>
                    <button type="button" className="mj_SettingsSheet_done" onClick={onClose}>
                        Done
                    </button>
                </header>
                <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-account">
                    <h3 id="mj-settings-account" className="mj_SettingsSheet_groupTitle">
                        Account
                    </h3>
                    <dl className="mj_SettingsSheet_rows">
                        <div className="mj_SettingsSheet_row">
                            <dt>User</dt>
                            <dd>{session?.username ?? "Signed out"}</dd>
                        </div>
                        <div className="mj_SettingsSheet_row">
                            <dt>Server</dt>
                            <dd>{session?.serverUrl ?? "—"}</dd>
                        </div>
                        <div className="mj_SettingsSheet_row">
                            <dt>Device</dt>
                            <dd>{session ? session.deviceId : "—"}</dd>
                        </div>
                        <div className="mj_SettingsSheet_row">
                            <dt>Connection</dt>
                            <dd>{connectionLabel}</dd>
                        </div>
                    </dl>
                </section>
                <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-appearance">
                    <h3 id="mj-settings-appearance" className="mj_SettingsSheet_groupTitle">
                        Appearance
                    </h3>
                    <div className="mj_TrackerSegment mj_SettingsSheet_appearance" role="group" aria-label="Appearance">
                        {APPEARANCE.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                data-theme={option.value}
                                aria-pressed={preference === option.pref}
                                onClick={() => setTheme(option.pref)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </section>
                <SecuritySettings client={client} onPasswordChanged={() => setDevicesRevision((n) => n + 1)} />
                <DevicesSettings client={client} session={session} revision={devicesRevision} />
                <UsersSettings client={client} />
                <DesktopNotifications client={client} />
                <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-developer">
                    <h3 id="mj-settings-developer" className="mj_SettingsSheet_groupTitle">
                        Developer
                    </h3>
                    <div className="mj_SettingsSheet_rows">
                        <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                            <span className="mj_SettingsSheet_switchText">
                                <span id="mj-settings-developer-view">Developer view</span>
                                <span id="mj-settings-developer-view-help" className="mj_SettingsSheet_help">
                                    Show each turn&apos;s tool calls, commands and helper activity inline.
                                </span>
                            </span>
                            <button
                                type="button"
                                role="switch"
                                className="mj_SettingsSheet_switch"
                                data-setting="developer-view"
                                aria-checked={developerView}
                                aria-labelledby="mj-settings-developer-view"
                                aria-describedby="mj-settings-developer-view-help"
                                onClick={() => setDeveloperView(!developerView)}
                            />
                        </div>
                    </div>
                </section>
                <NewChatDefaults client={client} />
                <BoxesDefaults client={client} />
                <CoordinatorSettings
                    client={client}
                    onChooseCoordinator={onChooseCoordinator}
                    onOpenRoutines={onOpenRoutines}
                />
                {notices !== undefined && onNoticesChange ? (
                    <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-foryou">
                        <h3 id="mj-settings-foryou" className="mj_SettingsSheet_groupTitle">
                            For you
                        </h3>
                        <div className="mj_SettingsSheet_rows">
                            <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                                <span className="mj_SettingsSheet_switchText">
                                    <span id="mj-settings-notices">Send things I need to read to For you</span>
                                    <span id="mj-settings-notices-help" className="mj_SettingsSheet_help">
                                        Agents file things you should read as items with a Seen button, instead of
                                        leaving them in chat.
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    role="switch"
                                    className="mj_SettingsSheet_switch"
                                    data-setting="notices"
                                    aria-checked={notices}
                                    aria-labelledby="mj-settings-notices"
                                    aria-describedby="mj-settings-notices-help"
                                    onClick={() => onNoticesChange(!notices)}
                                />
                            </div>
                        </div>
                        {noticesError ? (
                            <p className="mj_SettingsSheet_error" role="alert">
                                Couldn't save: {noticesError}
                            </p>
                        ) : null}
                    </section>
                ) : null}
                {autoApproveCoordinatorSpawns !== undefined && onAutoApproveCoordinatorSpawnsChange ? (
                    <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-spawns">
                        <h3 id="mj-settings-spawns" className="mj_SettingsSheet_groupTitle">
                            Sessions
                        </h3>
                        <div className="mj_SettingsSheet_rows">
                            <div className="mj_SettingsSheet_row mj_SettingsSheet_switchRow">
                                <span className="mj_SettingsSheet_switchText">
                                    <span id="mj-settings-auto-approve-spawns">
                                        Auto-approve spawns the Coordinator requests
                                    </span>
                                    <span id="mj-settings-auto-approve-spawns-help" className="mj_SettingsSheet_help">
                                        When on, a session the Coordinator starts on one of your own online boxes starts
                                        at once, without a consent card. Other requests still ask you.
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    role="switch"
                                    className="mj_SettingsSheet_switch"
                                    data-setting="auto_approve_coordinator_spawns"
                                    aria-checked={autoApproveCoordinatorSpawns}
                                    aria-labelledby="mj-settings-auto-approve-spawns"
                                    aria-describedby="mj-settings-auto-approve-spawns-help"
                                    onClick={() => onAutoApproveCoordinatorSpawnsChange(!autoApproveCoordinatorSpawns)}
                                />
                            </div>
                        </div>
                        {noticesError ? (
                            <p className="mj_SettingsSheet_error" role="alert">
                                Couldn't save: {noticesError}
                            </p>
                        ) : null}
                    </section>
                ) : null}
                {autoArchiveDays !== undefined && onAutoArchiveChange ? (
                    <section className="mj_SettingsSheet_group" aria-labelledby="mj-settings-archive">
                        <h3 id="mj-settings-archive" className="mj_SettingsSheet_groupTitle">
                            Archive
                        </h3>
                        <div className="mj_SettingsSheet_rows">
                            <label className="mj_SettingsSheet_row">
                                <span>Archive idle chats</span>
                                <select
                                    className="mj_SettingsSheet_select"
                                    data-setting="auto_archive_days"
                                    aria-describedby="mj-settings-archive-help"
                                    value={autoArchiveDays}
                                    onChange={(event) => onAutoArchiveChange(Number(event.target.value))}
                                >
                                    {(AUTO_ARCHIVE_CHOICES.includes(autoArchiveDays)
                                        ? AUTO_ARCHIVE_CHOICES
                                        : [...AUTO_ARCHIVE_CHOICES, autoArchiveDays].sort((a, b) => a - b)
                                    ).map((days) => (
                                        <option key={days} value={days}>
                                            {autoArchiveLabel(days)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>
                        <p id="mj-settings-archive-help" className="mj_SettingsSheet_help">
                            Chats with no activity move to Archived. Pinned chats, running sessions and chats with open
                            missions or items stay. A new message brings a chat back.
                        </p>
                        {autoArchiveError ? (
                            <p className="mj_SettingsSheet_error" role="alert">
                                Couldn't save: {autoArchiveError}
                            </p>
                        ) : null}
                    </section>
                ) : null}
                <button type="button" className="mj_SettingsSheet_signOut" data-action="sign-out" onClick={onSignOut}>
                    Sign out
                </button>
            </div>
        </div>
    );
}
