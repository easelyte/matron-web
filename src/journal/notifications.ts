/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Desktop notifications and the unread badge, while a tab is open (no service worker, no Web
 * Push). The phone and Mac apps are told what to show by the journal's push pipeline; a browser
 * tab is not a push target, so this module makes the same decision locally from the journal
 * events the tab already receives:
 *
 * - which switch an event falls under (the journal's push classification: prompts, questions,
 *   notices, a finished turn, activity…);
 * - whether the user's notification settings let it through (GET /notify: the synced mode and
 *   event switches, the per-conversation level or mute, and this device's own level), kept live
 *   by `notify` frames. A journal without the route falls back to: what needs the user, and
 *   agent messages;
 * - never for the user's own events, a subagent's child conversation, or the conversation open
 *   in a focused tab (this one or another).
 *
 * Several tabs see the same events; only one shows a notification. That needs no lock: the tabs
 * share one IndexedDB journal with one cursor, so exactly one tab newly applies each event, and
 * only that tab's client hands it to the live listener. Tabs tell each other which conversation
 * they show (BroadcastChannel) so a background tab never notifies about what a focused one has on
 * screen. Only one document can have focus at a time, so a tab that reports focus (or this tab
 * gaining it) clears every other tab's claim: a tab that crashed while focused leaves nothing
 * behind.
 *
 * The document title carries the unread total ("(3) Matron") and so does the app badge where
 * the browser has one (navigator.setAppBadge), counted like the nav rail's badge.
 */

import { JournalApi, JournalApiError } from "./api";
import type { LiveListener, MatronJournalClient } from "./client";
import { effectiveUnread } from "./conversation-flags";
import { isJoinedRoom } from "./conversation-rooms";
import { displayTitle } from "./SessionTag";
import { type ClientState, type Conversation, eventSnippet, type JournalEvent, type Session } from "./types";

// ── Settings model (journal src/notify.js) ──────────────────────────────────────────────────

export type NotifyMode = "coordinator" | "all" | "custom";
export const NOTIFY_EVENTS = [
    "prompts",
    "questions",
    "notices",
    "coordinator_done",
    "other_done",
    "stopped",
    "rooms",
    "activity",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export type NotifyConvoLevel = "all" | "needs_me" | "none";
export type NotifyDeviceLevel = "all" | "needs_me" | "off";

/** One conversation's own level (null = follow the mode) and mute (epoch ms, null = none). */
export interface NotifyConvoOverride {
    convo_id: string;
    level: NotifyConvoLevel | null;
    mute_until: number | null;
}

/** The synced part: what a `notify` frame carries. */
export interface NotifySettings {
    mode: NotifyMode;
    events: Record<NotifyEvent, boolean>;
    /** Coordinator mode with no Coordinator set acts as "Every session". */
    has_coordinator: boolean;
    convos: NotifyConvoOverride[];
}

/** The whole GET /notify answer: the synced settings plus this device's level. */
export interface NotifyView extends NotifySettings {
    device_level: NotifyDeviceLevel;
}

// What "Needs me" lets through, at conversation and device level alike.
const NEEDS_ME = new Set<string>(["prompts", "questions", "notices"]);

const PRESET_ALL: Record<NotifyEvent, boolean> = {
    prompts: true,
    questions: true,
    notices: true,
    coordinator_done: true,
    other_done: true,
    stopped: true,
    rooms: false,
    activity: false,
};

/**
 * Decodes the synced settings (a `notify` frame's `settings`, or GET /notify). Null when the mode
 * is missing or unknown. A missing switch reads as off, except `notices` (on in every preset, and
 * absent from a journal that predates it) and `prompts`, which is always on: an unanswered prompt
 * blocks an agent.
 */
export function parseNotifySettings(raw: unknown): NotifySettings | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (obj.mode !== "coordinator" && obj.mode !== "all" && obj.mode !== "custom") return null;
    const rawEvents: Record<string, unknown> =
        obj.events && typeof obj.events === "object" ? (obj.events as Record<string, unknown>) : {};
    const events = {} as Record<NotifyEvent, boolean>;
    for (const event of NOTIFY_EVENTS) {
        const value = rawEvents[event];
        events[event] = typeof value === "boolean" ? value : event === "notices";
    }
    events.prompts = true;
    const convos: NotifyConvoOverride[] = [];
    for (const row of Array.isArray(obj.convos) ? obj.convos : []) {
        if (!row || typeof row !== "object") continue;
        const { convo_id: id, level, mute_until: muteUntil } = row as Record<string, unknown>;
        if (typeof id !== "string" || !id) continue;
        convos.push({
            convo_id: id,
            level: level === "all" || level === "needs_me" || level === "none" ? level : null,
            mute_until: typeof muteUntil === "number" && Number.isFinite(muteUntil) ? muteUntil : null,
        });
    }
    return { mode: obj.mode, events, has_coordinator: obj.has_coordinator === true, convos };
}

/** Decodes GET /notify. This device's level defaults to `all`. */
export function parseNotifyView(raw: unknown): NotifyView | null {
    const settings = parseNotifySettings(raw);
    if (!settings) return null;
    const level = (raw as Record<string, unknown>).device_level;
    return { ...settings, device_level: level === "needs_me" || level === "off" ? level : "all" };
}

/** The switches in force: Coordinator mode only means something while there is a Coordinator. */
export function effectiveEvents(settings: NotifySettings): Record<NotifyEvent, boolean> {
    return settings.mode === "coordinator" && !settings.has_coordinator ? { ...PRESET_ALL } : settings.events;
}

// The switches each preset fixes (journal src/notify.js PRESETS); custom keeps its own.
const PRESET_COORDINATOR: Record<NotifyEvent, boolean> = {
    ...PRESET_ALL,
    other_done: false,
    stopped: false,
};

// ── Changes (PUT /notify) ─────────────────────────────────────────────────────────────────────

/** One change the user makes, so a failed write takes back exactly that change. */
export type NotifyChange =
    | { kind: "mode"; mode: NotifyMode }
    /** Switching an event while on a preset moves the user to custom, starting from that preset. */
    | { kind: "event"; event: NotifyEvent; on: boolean }
    | { kind: "device_level"; level: NotifyDeviceLevel }
    /** null = follow the mode. Leaves any mute as it is. */
    | { kind: "convo_level"; convoId: string; level: NotifyConvoLevel | null }
    /** null = unmute. Leaves the level as it is. */
    | { kind: "convo_mute"; convoId: string; until: number | null }
    /** Drops the conversation's override entirely: level and mute. */
    | { kind: "clear_convo"; convoId: string };

/** The PUT /notify body. An explicit null clears a level or a mute; an absent key leaves it. */
export function notifyChangeBody(change: NotifyChange): Record<string, unknown> {
    switch (change.kind) {
        case "mode":
            return { mode: change.mode };
        case "event":
            return { events: { [change.event]: change.on } };
        case "device_level":
            return { device_level: change.level };
        case "convo_level":
            return { convo: { convo_id: change.convoId, level: change.level } };
        case "convo_mute":
            return { convo: { convo_id: change.convoId, mute_until: change.until } };
        case "clear_convo":
            return { convo: { convo_id: change.convoId, level: null, mute_until: null } };
    }
}

/** Edits one conversation's row (a changed row goes first, as the journal lists the latest change
 *  first); a row left with neither a level nor a mute is dropped, as the journal deletes it. */
function updatingConvo(
    convos: NotifyConvoOverride[],
    convoId: string,
    edit: (row: NotifyConvoOverride) => NotifyConvoOverride,
): NotifyConvoOverride[] {
    const current = convos.find((row) => row.convo_id === convoId) ?? {
        convo_id: convoId,
        level: null,
        mute_until: null,
    };
    const next = edit(current);
    const rest = convos.filter((row) => row.convo_id !== convoId);
    return next.level !== null || next.mute_until !== null ? [next, ...rest] : rest;
}

/** The change as the journal will apply it (setNotifyPrefs / setConvoNotify), for the copy shown
 *  while the PUT is in flight. */
export function applyNotifyChange(view: NotifyView, change: NotifyChange): NotifyView {
    switch (change.kind) {
        case "mode":
            // Custom keeps whatever switches were showing.
            return {
                ...view,
                mode: change.mode,
                events:
                    change.mode === "all"
                        ? { ...PRESET_ALL }
                        : change.mode === "coordinator"
                          ? { ...PRESET_COORDINATOR }
                          : view.events,
            };
        case "event":
            return {
                ...view,
                mode: "custom",
                events: { ...view.events, [change.event]: change.event === "prompts" ? true : change.on },
            };
        case "device_level":
            return { ...view, device_level: change.level };
        case "convo_level":
            return {
                ...view,
                convos: updatingConvo(view.convos, change.convoId, (row) => ({ ...row, level: change.level })),
            };
        case "convo_mute":
            return {
                ...view,
                convos: updatingConvo(view.convos, change.convoId, (row) => ({ ...row, mute_until: change.until })),
            };
        case "clear_convo":
            return { ...view, convos: view.convos.filter((row) => row.convo_id !== change.convoId) };
    }
}

/** The mute choices a conversation's Notifications menu offers. */
export type NotifyMuteDuration = "hour" | "eight_hours" | "tomorrow_morning";
export const NOTIFY_MUTE_DURATIONS: readonly NotifyMuteDuration[] = ["hour", "eight_hours", "tomorrow_morning"];

/** When a mute started at `now` ends; "tomorrow" is 08:00 on the next calendar day, local time. */
export function muteEnd(duration: NotifyMuteDuration, now: number): number {
    if (duration === "hour") return now + 60 * 60_000;
    if (duration === "eight_hours") return now + 8 * 60 * 60_000;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    return tomorrow.getTime();
}

/** One conversation's notification state as the header and the lists show it. */
export interface ConvoNotifyState {
    /** null = follow the mode. */
    level: NotifyConvoLevel | null;
    /** Only while the mute runs; a lapsed one reads null. */
    mutedUntil: number | null;
    /** Nothing from this conversation notifies: level None, or a mute still running. */
    silenced: boolean;
}

export function convoNotifyState(
    view: NotifySettings | null | undefined,
    convoId: string,
    now: number,
): ConvoNotifyState {
    const row = view?.convos.find((candidate) => candidate.convo_id === convoId);
    const level = row?.level ?? null;
    const mutedUntil = row?.mute_until != null && row.mute_until > now ? row.mute_until : null;
    return { level, mutedUntil, silenced: level === "none" || mutedUntil !== null };
}

/** The conversations with a level or a running mute, latest change first. */
export function activeOverrides(view: NotifySettings | null | undefined, now: number): NotifyConvoOverride[] {
    return (view?.convos ?? []).filter(
        (row) => row.level !== null || (row.mute_until !== null && row.mute_until > now),
    );
}

// ── Words (the Mac's NotifySettings+Titles) ───────────────────────────────────────────────────

export const NOTIFY_MODE_TITLES: Record<NotifyMode, { title: string; subtitle: string }> = {
    coordinator: { title: "Coordinator mode", subtitle: "Only the Coordinator's turns and anything that needs you" },
    all: { title: "Every session", subtitle: "Every session's turns and anything that needs you" },
    custom: { title: "Custom", subtitle: "Your own choice of the events below" },
};

export const NOTIFY_EVENT_TITLES: Record<NotifyEvent, string> = {
    prompts: "Permission prompts & secret requests",
    questions: "Questions and items awaiting me",
    notices: "Things to read",
    coordinator_done: "Coordinator finished a turn",
    other_done: "Other sessions finished a turn",
    stopped: "A session stopped or crashed mid-turn",
    rooms: "Agent room messages",
    activity: "Routine activity (batched)",
};

export const NOTIFY_CONVO_LEVEL_TITLES: Record<NotifyConvoLevel, string> = {
    all: "All",
    needs_me: "Needs me",
    none: "None",
};

export const NOTIFY_DEFAULT_LEVEL_TITLE = "Default (follow mode)";

export const NOTIFY_DEVICE_LEVEL_TITLES: Record<NotifyDeviceLevel, string> = {
    all: "All of the above",
    needs_me: "Needs-me only",
    off: "Off",
};

export const NOTIFY_MUTE_TITLES: Record<NotifyMuteDuration, string> = {
    hour: "Mute for 1 hour",
    eight_hours: "Mute for 8 hours",
    tomorrow_morning: "Mute until tomorrow 08:00",
};

/** The time alone today, with the weekday otherwise. */
export function muteTime(at: number, now: number): string {
    const date = new Date(at);
    const sameDay = new Date(now).toDateString() === date.toDateString();
    return date.toLocaleString(undefined, {
        ...(sameDay ? {} : { weekday: "short" }),
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** One line for an overrides row: the level and the running mute, e.g. "Needs me · muted until 14:00". */
export function convoNotifySummary(state: ConvoNotifyState, now: number): string {
    const parts: string[] = [];
    if (state.level) parts.push(NOTIFY_CONVO_LEVEL_TITLES[state.level]);
    if (state.mutedUntil !== null) parts.push(`muted until ${muteTime(state.mutedUntil, now)}`);
    const text = parts.join(" · ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Classification (journal src/push.js classify + src/notify.js eventKey) ────────────────────

export interface NotifyClass {
    kind: "attention" | "done" | "activity";
    question?: boolean;
    notice?: boolean;
    stopped?: boolean;
}

/**
 * Whether an event could notify at all, and how. Null for the user's own events, bookkeeping
 * (renames, summaries, missions, milestones, consent decisions) and session-state changes other
 * than a turn ending (running → waiting) or a session stopping mid-work (running → done).
 * `prevState` is the conversation's session state before this event.
 */
export function classifyEvent(event: JournalEvent, prevState: string | undefined): NotifyClass | null {
    const { type, payload, sender } = event;
    if (typeof sender === "string" && sender.startsWith("user:")) return null;
    // An old-client fallback text mirrors a tracker marker that made its own decision.
    if (type === "text" && payload.fallback_for) return null;
    if (type === "prompt" || type === "permission_request") return { kind: "attention" };
    if (type === "session_status") {
        const state = payload.state;
        const turnFinished = prevState === "running" && (state === "waiting" || state === "done");
        return turnFinished ? { kind: "done", stopped: state === "done" } : null;
    }
    if (type === "item") {
        // Only "the agent needs you": an agent-authored create, comment or reopen left awaiting the user.
        const needsUser =
            payload.awaiting === "user" &&
            payload.by === "agent" &&
            (payload.action === "created" || payload.action === "commented" || payload.action === "reopened");
        if (!needsUser) return null;
        return payload.kind === "notice"
            ? { kind: "attention", question: true, notice: true }
            : { kind: "attention", question: true };
    }
    if (
        type === "convo_meta" ||
        type === "summary" ||
        type === "milestone" ||
        type === "mission" ||
        type === "consent_decision" ||
        type === "read_marker"
    ) {
        return null;
    }
    return { kind: "activity" };
}

/** The event switch a classified event falls under. */
export function eventKey(cls: NotifyClass, convo: { isCoordinator: boolean; isRoom: boolean }): NotifyEvent {
    if (cls.kind === "attention") return cls.notice ? "notices" : cls.question ? "questions" : "prompts";
    if (cls.kind === "done") {
        if (convo.isCoordinator) return "coordinator_done";
        return cls.stopped ? "stopped" : "other_done";
    }
    return convo.isRoom ? "rooms" : "activity";
}

/** Whether an event passes the user's switches and this conversation's level or mute. */
export function allowedForUser(
    key: NotifyEvent,
    events: Record<NotifyEvent, boolean>,
    override: NotifyConvoOverride | undefined,
    now: number,
): boolean {
    if (override) {
        if (override.mute_until !== null && override.mute_until > now) return false;
        if (override.level === "none") return false;
        if (override.level === "needs_me") return NEEDS_ME.has(key);
        if (override.level === "all") {
            if (key === "rooms" || key === "activity") return events[key] === true;
            return true;
        }
    }
    return events[key] === true;
}

/** This device's own level: all, only what needs the user, or nothing. */
export function allowedForDevice(key: NotifyEvent, level: NotifyDeviceLevel): boolean {
    if (level === "off") return false;
    if (level === "needs_me") return NEEDS_ME.has(key);
    return true;
}

// Agent messages that notify when the journal's settings are unavailable (not tool output or diffs).
const FALLBACK_MESSAGE_TYPES = new Set(["text", "file", "image"]);

/**
 * The whole decision for one classified event. Without settings (a journal that predates them, or
 * one not read yet): what needs the user, and agent messages.
 */
export function shouldNotify(
    key: NotifyEvent,
    eventType: string,
    convoId: string,
    view: NotifyView | null,
    now: number,
): boolean {
    if (!view)
        return NEEDS_ME.has(key) || ((key === "activity" || key === "rooms") && FALLBACK_MESSAGE_TYPES.has(eventType));
    const override = view.convos.find((row) => row.convo_id === convoId);
    return allowedForUser(key, effectiveEvents(view), override, now) && allowedForDevice(key, view.device_level);
}

/** What the notification says: the journal's push body for the event. */
export function notificationBody(event: JournalEvent): string {
    if (event.type === "session_status") return "Turn finished";
    return eventSnippet(event.type, event.payload) || `[${event.type}]`;
}

// ── Unread badge ─────────────────────────────────────────────────────────────────────────────

/**
 * The unread total the nav rail, the title and the app badge show: every conversation's unread
 * count, archived ones excluded; a conversation marked unread by hand counts once.
 */
export function unreadTotal(
    conversations: ReadonlyArray<Pick<Conversation, "id" | "unread_count">>,
    archivedIds: ReadonlySet<string>,
    unreadOverrideIds: Set<string>,
): number {
    return conversations.reduce((total, conversation) => {
        if (archivedIds.has(conversation.id)) return total;
        if (conversation.unread_count > 0) return total + conversation.unread_count;
        return total + (effectiveUnread(conversation, unreadOverrideIds) ? 1 : 0);
    }, 0);
}

const TITLE_COUNT = /^\(\d+\) /;

/** "(3) Matron"; the bare title at zero. */
export function titleWithUnread(base: string, count: number): string {
    const bare = base.replace(TITLE_COUNT, "");
    return count > 0 ? `(${count}) ${bare}` : bare;
}

// ── The notifier ─────────────────────────────────────────────────────────────────────────────

export type NotificationPermissionState = "unsupported" | "default" | "granted" | "denied";

/** What the Settings entry shows. */
export interface DesktopNotificationsState {
    permission: NotificationPermissionState;
    /** On: the user turned it on here and the browser allows it. */
    enabled: boolean;
    sound: boolean;
}

interface NotificationLike {
    onclick: ((this: NotificationLike, event: Event) => unknown) | null;
    close(): void;
}

export interface NotificationConstructorLike {
    new (title: string, options?: NotificationOptions & { renotify?: boolean }): NotificationLike;
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
}

interface ChannelLike {
    postMessage(message: unknown): void;
    close(): void;
    onmessage: ((event: MessageEvent) => void) | null;
}

interface NotifyApi {
    notifySettings(): Promise<unknown>;
    updateNotify(body: Record<string, unknown>): Promise<unknown>;
    coordinator(): Promise<unknown>;
}

/** What the notification settings screen and the chat header's bell show. */
export interface NotifySettingsState {
    /** The journal's last answer with the writes still in flight on top. Undefined until read;
     *  null on a journal without notification settings. */
    view: NotifyView | null | undefined;
    /** The last failed write or read. Cleared by the next success. */
    error: string | null;
    /** The clock mutes are judged by: moves when a running mute ends. */
    now: number;
}

/** Everything the notifier touches outside itself; tests pass fakes. */
export interface NotifierEnvironment {
    Notification?: NotificationConstructorLike;
    channel?: () => ChannelLike | undefined;
    storage?: Storage;
    document?: Document;
    window?: Window;
    now: () => number;
    setAppBadge?: (count: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
    api: (session: Session) => NotifyApi;
}

const PREFS_KEY = "matron_desktop_notifications_v1";
const CHANNEL = "matron-desktop-notifications";
// Events older than this when they arrive (a reconnect replaying what was missed) only update the
// list: a burst of stale notifications after a laptop wakes says nothing the badge does not.
export const STALE_EVENT_MS = 2 * 60_000;

function defaultEnvironment(): NotifierEnvironment {
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    const badgeNav = nav as
        (Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> }) | undefined;
    let storage: Storage | undefined;
    try {
        storage = window.localStorage;
    } catch {
        storage = undefined;
    }
    return {
        Notification: typeof Notification === "undefined" ? undefined : (Notification as NotificationConstructorLike),
        channel: () => (typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(CHANNEL)),
        storage,
        document: typeof document === "undefined" ? undefined : document,
        window: typeof window === "undefined" ? undefined : window,
        now: () => Date.now(),
        setAppBadge: badgeNav?.setAppBadge ? (n) => badgeNav.setAppBadge!(n) : undefined,
        clearAppBadge: badgeNav?.clearAppBadge ? () => badgeNav.clearAppBadge!() : undefined,
        api: (session) => new JournalApi(session.serverUrl, session.token),
    };
}

interface PeerView {
    focused: boolean;
    convoId: string | null;
}

export class DesktopNotifier {
    private readonly env: NotifierEnvironment;
    private readonly tabId = Math.random().toString(36).slice(2);
    private readonly listeners = new Set<() => void>();
    private snapshot: DesktopNotificationsState;
    private starts = 0;
    private teardown: Array<() => void> = [];
    private channel?: ChannelLike;
    private readonly peers = new Map<string, PeerView>();
    private lastAnnounced = "";
    private baseTitle?: string;
    private lastBadge = -1;
    // The journal's settings for the signed-in session: null = a journal without them (the
    // fallback rules), undefined = not read yet or the read failed (only what needs the user).
    private view: NotifyView | null | undefined = undefined;
    // Each conversation's session state as the journal frames reached this tab, and the state
    // before the latest session_status frame. Every tab sees every frame, but only one applies
    // each event, so the client's own conversation list can miss the "running" another tab applied.
    private readonly sessionStates = new Map<string, { seq: number; state: string; before: string | undefined }>();
    // The notification on screen per conversation, closed on sign-out.
    private readonly open = new Map<string, NotificationLike>();
    private coordinatorId: string | null = null;
    private sessionKey?: string;
    // Moves on every live `notify` frame and session change: a GET sent before is older news.
    private settingsEpoch = 0;
    // Moves on every session change: an answer for the previous session is dropped.
    private sessionEpoch = 0;
    // Preferences when storage refuses to save them: they last until the page reloads.
    private memoryPrefs: { enabled?: boolean; sound?: boolean } = {};
    private lastConnection?: string;
    // Writes still in flight, replayed over `view` (the journal's last answer) so overlapping
    // writes never take each other back and a frame or GET landing mid-write keeps them showing.
    private pending: Array<{ id: number; change: NotifyChange }> = [];
    private nextWriteId = 0;
    // The newest write whose answer became `view`: an older write answering late is older news.
    private newestAnsweredWrite = -1;
    // Counts answered writes, so a GET that was in flight across one leaves this device's level alone.
    private answeredWrites = 0;
    private settingsError: string | null = null;
    private readonly settingsListeners = new Set<() => void>();
    private settingsSnapshot: NotifySettingsState;
    private expiryTimer?: ReturnType<typeof setTimeout>;

    public constructor(
        private readonly client: MatronJournalClient,
        env: Partial<NotifierEnvironment> = {},
    ) {
        this.env = { ...defaultEnvironment(), ...env };
        this.snapshot = this.computeSnapshot();
        this.settingsSnapshot = { view: undefined, error: null, now: this.env.now() };
    }

    public readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    public readonly getSnapshot = (): DesktopNotificationsState => this.snapshot;

    public readonly subscribeSettings = (listener: () => void): (() => void) => {
        this.settingsListeners.add(listener);
        return () => this.settingsListeners.delete(listener);
    };

    public readonly getSettingsSnapshot = (): NotifySettingsState => this.settingsSnapshot;

    /** GET /notify again — on opening the settings screen, as well as on every connect. */
    public refreshSettings(): Promise<void> {
        return this.loadSettings();
    }

    /** Shows `change` at once, then PUTs it. The answer becomes the confirmed state; a failure
     *  takes back just this change. */
    public async changeSettings(change: NotifyChange): Promise<void> {
        const session = this.client.getSnapshot().session;
        if (!session) return;
        if (change.kind === "event" && change.event === "prompts") return;
        const sessionEpoch = this.sessionEpoch;
        const id = this.nextWriteId++;
        this.pending.push({ id, change });
        this.emitSettings();
        try {
            const answer = parseNotifyView(await this.env.api(session).updateNotify(notifyChangeBody(change)));
            if (sessionEpoch !== this.sessionEpoch) return;
            this.pending = this.pending.filter((write) => write.id !== id);
            if (answer && id > this.newestAnsweredWrite) {
                this.newestAnsweredWrite = id;
                this.view = answer;
                this.settingsEpoch += 1;
                this.answeredWrites += 1;
            }
            this.settingsError = null;
        } catch (error) {
            if (sessionEpoch !== this.sessionEpoch) return;
            this.pending = this.pending.filter((write) => write.id !== id);
            const reason = error instanceof Error && error.message ? ` — ${error.message}` : "";
            this.settingsError = `Couldn't save notification settings${reason}`;
        }
        this.emitSettings();
    }

    /** A conversation's own level (null = follow the mode); any mute stays. */
    public setConvoLevel(convoId: string, level: NotifyConvoLevel | null): Promise<void> {
        return this.changeSettings({ kind: "convo_level", convoId, level });
    }

    public muteConvo(convoId: string, duration: NotifyMuteDuration): Promise<void> {
        return this.changeSettings({ kind: "convo_mute", convoId, until: muteEnd(duration, this.env.now()) });
    }

    public unmuteConvo(convoId: string): Promise<void> {
        return this.changeSettings({ kind: "convo_mute", convoId, until: null });
    }

    /** Starts watching the client; the returned function stops. Safe to call more than once. */
    public start(): () => void {
        this.starts += 1;
        if (this.starts === 1) this.attach();
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            this.starts -= 1;
            if (this.starts === 0) this.detach();
        };
    }

    /** Turns notifications on, asking the browser first. Call from a click: browsers require it. */
    public async enable(): Promise<void> {
        const api = this.env.Notification;
        if (!api) return;
        let permission = api.permission;
        if (permission === "default") {
            try {
                permission = await api.requestPermission();
            } catch {
                permission = api.permission;
            }
        }
        // refresh() reads the settings once this turns notifications on.
        this.writePrefs({ enabled: true });
        this.refresh();
    }

    public disable(): void {
        this.writePrefs({ enabled: false });
        this.refresh();
    }

    public setSound(sound: boolean): void {
        this.writePrefs({ sound });
        this.refresh();
    }

    // ── Lifecycle ──

    private attach(): void {
        const doc = this.env.document;
        this.baseTitle = (doc?.title ?? "Matron").replace(TITLE_COUNT, "");
        const live: LiveListener = {
            journalEvent: (event, previous) => this.onJournalEvent(event, previous),
            frame: (frame) => this.onFrame(frame),
        };
        this.teardown.push(this.client.addLiveListener(live));
        this.teardown.push(this.client.subscribe(() => this.onClientChange()));

        const win = this.env.window;
        if (win) {
            const onFocusChange = (): void => {
                // Only one document has focus: no other tab can have a conversation on screen.
                if (this.ownView().focused) this.peers.clear();
                this.refresh();
                this.announce();
            };
            const onHide = (): void => this.post({ type: "view", tab: this.tabId, focused: false, convoId: null });
            win.addEventListener("focus", onFocusChange);
            win.addEventListener("blur", onFocusChange);
            win.addEventListener("pagehide", onHide);
            doc?.addEventListener("visibilitychange", onFocusChange);
            this.teardown.push(() => {
                win.removeEventListener("focus", onFocusChange);
                win.removeEventListener("blur", onFocusChange);
                win.removeEventListener("pagehide", onHide);
                doc?.removeEventListener("visibilitychange", onFocusChange);
            });
        }

        try {
            this.channel = this.env.channel?.();
        } catch {
            this.channel = undefined;
        }
        if (this.channel) {
            this.channel.onmessage = (event) => this.onPeerMessage(event.data);
            this.post({ type: "query" });
        }

        this.onClientChange();
        this.announce();
    }

    private detach(): void {
        this.post({ type: "view", tab: this.tabId, focused: false, convoId: null });
        for (const stop of this.teardown.splice(0)) stop();
        this.channel?.close();
        this.channel = undefined;
        this.peers.clear();
        this.lastAnnounced = "";
        this.sessionStates.clear();
        // Signed out (or unmounted): no count and no message text left behind.
        for (const notification of this.open.values()) {
            try {
                notification.close();
            } catch {
                // Already gone.
            }
        }
        this.open.clear();
        if (this.env.document && this.baseTitle !== undefined) this.env.document.title = this.baseTitle;
        this.lastBadge = -1;
        if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
        this.expiryTimer = undefined;
    }

    // ── Client state: title, badge, session, connection ──

    private onClientChange(): void {
        const state = this.client.getSnapshot();
        this.updateBadge(state);
        this.announce();

        const session = state.phase === "signed-in" ? state.session : undefined;
        const key = session ? `${session.serverUrl}|${session.userId}|${session.token}` : undefined;
        if (key !== this.sessionKey) {
            this.sessionKey = key;
            this.view = undefined;
            this.sessionStates.clear();
            this.coordinatorId = null;
            this.settingsEpoch += 1;
            this.sessionEpoch += 1;
            this.lastConnection = undefined;
            this.pending = [];
            this.settingsError = null;
            this.emitSettings();
        }
        // The `notify` frame is never replayed, so each (re)connect reads the settings again. Read
        // even with desktop notifications off: Settings and the chat header edit them.
        if (session && state.connection !== this.lastConnection) {
            this.lastConnection = state.connection;
            if (state.connection === "online") void this.loadSettings();
        }
    }

    private updateBadge(state: ClientState): void {
        const count =
            state.phase === "signed-in"
                ? unreadTotal(state.conversations, state.archivedIds, state.unreadOverrideIds)
                : 0;
        const doc = this.env.document;
        if (doc && this.baseTitle !== undefined) {
            const title = titleWithUnread(this.baseTitle, count);
            if (doc.title !== title) doc.title = title;
        }
        if (count === this.lastBadge) return;
        this.lastBadge = count;
        const badge = count > 0 ? this.env.setAppBadge?.(count) : this.env.clearAppBadge?.();
        badge?.catch(() => undefined);
    }

    private async loadSettings(): Promise<void> {
        const session = this.client.getSnapshot().session;
        if (!session) return;
        const epoch = this.settingsEpoch;
        const sessionEpoch = this.sessionEpoch;
        const answeredWrites = this.answeredWrites;
        const api = this.env.api(session);
        const [notify, coordinator] = await Promise.allSettled([api.notifySettings(), api.coordinator()]);
        if (sessionEpoch !== this.sessionEpoch) return;
        if (coordinator.status === "fulfilled") this.coordinatorId = parseCoordinatorId(coordinator.value);
        const answer = notify.status === "fulfilled" ? parseNotifyView(notify.value) : null;
        if (epoch !== this.settingsEpoch) {
            // A live frame landed meanwhile and holds the newer synced part, but frames never carry
            // this device's level: take that from the answer — unless a write answered meanwhile,
            // whose answer already holds a newer level than this read.
            if (answer && this.view && answeredWrites === this.answeredWrites) {
                this.view = { ...this.view, device_level: answer.device_level };
            }
            this.emitSettings();
            return;
        }
        if (notify.status === "fulfilled") {
            this.view = answer;
            this.settingsError = null;
        } else if (notify.reason instanceof JournalApiError && notify.reason.status === 404) {
            // A journal without notification settings: the fallback rules apply.
            this.view = null;
        } else if (this.view === undefined) {
            this.settingsError = "Couldn't load notification settings";
        }
        this.emitSettings();
    }

    private async loadCoordinator(): Promise<void> {
        const session = this.client.getSnapshot().session;
        if (!session) return;
        const epoch = this.sessionEpoch;
        try {
            const raw = await this.env.api(session).coordinator();
            if (epoch === this.sessionEpoch) this.coordinatorId = parseCoordinatorId(raw);
        } catch {
            // Keep the last known Coordinator.
        }
    }

    // ── Live frames and events ──

    private onFrame(frame: unknown): void {
        const candidate = frame as { kind?: unknown; settings?: unknown };
        if (candidate.kind === "journal") {
            this.trackSessionState(frame as JournalEvent);
            return;
        }
        if (candidate.kind !== "notify") return;
        const settings = parseNotifySettings(candidate.settings);
        if (!settings) return;
        // The frame is the synced part only: this device's level stays as the last GET left it.
        this.view = { ...settings, device_level: this.view?.device_level ?? "all" };
        this.settingsEpoch += 1;
        this.emitSettings();
    }

    private trackSessionState(event: JournalEvent): void {
        if (event.type !== "session_status" || typeof event.payload?.state !== "string") return;
        if (typeof event.convo_id !== "string" || typeof event.seq !== "number") return;
        const known = this.sessionStates.get(event.convo_id);
        if (known && known.seq >= event.seq) return;
        // Whichever is newer: the frames this tab saw, or its list (a snapshot can move a state
        // without a frame).
        const row = this.client.getSnapshot().conversations.find((candidate) => candidate.id === event.convo_id);
        const before = row && (!known || row.last_seq > known.seq) ? row.session_state : known?.state;
        this.sessionStates.set(event.convo_id, { seq: event.seq, state: event.payload.state, before });
    }

    /** The session state before this event: from the frames when they saw it, else the client's list. */
    private stateBefore(event: JournalEvent, previous: Conversation | undefined): string | undefined {
        const known = event.type === "session_status" ? this.sessionStates.get(event.convo_id) : undefined;
        return known && known.seq === event.seq ? known.before : previous?.session_state;
    }

    private onJournalEvent(event: JournalEvent, previous: Conversation | undefined): void {
        if (event.type === "coordinator") void this.loadCoordinator();
        if (!this.snapshot.enabled) return;
        const now = this.env.now();
        if (typeof event.ts === "number" && event.ts < now - STALE_EVENT_MS) return;
        // A subagent's child conversation never notifies (the journal never pushes for one either).
        if (previous?.parent_convo_id || typeof event.payload.parent_convo_id === "string") return;
        const cls = classifyEvent(event, this.stateBefore(event, previous));
        if (!cls) return;
        const key = eventKey(cls, {
            isCoordinator: event.convo_id === this.coordinatorId,
            isRoom: isJoinedRoom(previous),
        });
        // Settings not read yet (or the read failed): only what needs the user, which every preset sends.
        const view = this.shownView();
        const allowed =
            view === undefined ? NEEDS_ME.has(key) : shouldNotify(key, event.type, event.convo_id, view, now);
        if (!allowed) return;
        if (this.isOnScreen(event.convo_id)) return;
        this.show(event, previous, cls);
    }

    private isOnScreen(convoId: string): boolean {
        const own = this.ownView();
        if (own.focused && own.convoId === convoId) return true;
        for (const peer of this.peers.values()) if (peer.focused && peer.convoId === convoId) return true;
        return false;
    }

    private show(event: JournalEvent, previous: Conversation | undefined, cls: NotifyClass): void {
        const api = this.env.Notification;
        if (!api || api.permission !== "granted") return;
        const conversationId = event.convo_id;
        let notification: NotificationLike;
        try {
            notification = new api(previous ? displayTitle(previous) : conversationId, {
                body: notificationBody(event),
                // One notification per conversation: a newer one replaces it. What needs the user
                // alerts again; routine activity updates quietly.
                tag: `matron:${conversationId}`,
                renotify: cls.kind !== "activity",
                silent: !this.snapshot.sound,
                data: { convo_id: conversationId, seq: event.seq },
            });
        } catch (error) {
            console.warn("matron:notification", error);
            return;
        }
        this.open.set(conversationId, notification);
        notification.onclick = () => {
            this.env.window?.focus();
            void this.client.selectConversation(conversationId);
            notification.close();
            if (this.open.get(conversationId) === notification) this.open.delete(conversationId);
        };
    }

    // ── Tabs ──

    private ownView(): PeerView {
        const doc = this.env.document;
        const focused = Boolean(doc && doc.visibilityState === "visible" && doc.hasFocus());
        const state = this.client.getSnapshot();
        const convoId = state.trackerView?.open ? null : (state.selectedConversationId ?? null);
        return { focused, convoId };
    }

    private announce(): void {
        if (!this.channel) return;
        const view = this.ownView();
        const key = `${view.focused}|${view.convoId ?? ""}`;
        if (key === this.lastAnnounced) return;
        this.lastAnnounced = key;
        this.post({ type: "view", tab: this.tabId, ...view });
    }

    private onPeerMessage(data: unknown): void {
        if (!data || typeof data !== "object") return;
        const message = data as { type?: unknown; tab?: unknown; focused?: unknown; convoId?: unknown };
        if (message.type === "query") {
            this.lastAnnounced = "";
            this.announce();
            return;
        }
        if (message.type !== "view" || typeof message.tab !== "string" || message.tab === this.tabId) return;
        if (message.focused === true) {
            // Only one document has focus: whichever tab had it before no longer does.
            this.peers.clear();
            this.peers.set(message.tab, {
                focused: true,
                convoId: typeof message.convoId === "string" ? message.convoId : null,
            });
        } else {
            this.peers.delete(message.tab);
        }
    }

    private post(message: Record<string, unknown>): void {
        try {
            this.channel?.postMessage(message);
        } catch {
            // A closed channel: nothing to tell.
        }
    }

    // ── Notification settings snapshot ──

    private shownView(): NotifyView | null | undefined {
        const confirmed = this.view;
        if (!confirmed) return confirmed;
        return this.pending.reduce((view, write) => applyNotifyChange(view, write.change), confirmed);
    }

    private emitSettings(): void {
        const now = this.env.now();
        this.settingsSnapshot = { view: this.shownView(), error: this.settingsError, now };
        this.scheduleMuteExpiry(now);
        for (const listener of this.settingsListeners) listener();
    }

    /** Wakes when the soonest running mute ends, so the bell-slash goes away on time. */
    private scheduleMuteExpiry(now: number): void {
        if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
        this.expiryTimer = undefined;
        const ends = (this.settingsSnapshot.view?.convos ?? [])
            .map((row) => row.mute_until)
            .filter((end): end is number => end !== null && end > now);
        if (ends.length === 0 || this.starts === 0) return;
        // Capped: a timer longer than a 32-bit millisecond count fires at once.
        const delay = Math.min(Math.min(...ends) - now + 50, 2 ** 31 - 1);
        this.expiryTimer = setTimeout(() => {
            this.expiryTimer = undefined;
            this.emitSettings();
        }, delay);
    }

    // ── Preferences and the Settings snapshot ──

    private readPrefs(): { enabled?: boolean; sound?: boolean } {
        try {
            const raw = this.env.storage?.getItem(PREFS_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            if (!parsed || typeof parsed !== "object") return {};
            const { enabled, sound } = parsed as Record<string, unknown>;
            return {
                ...(typeof enabled === "boolean" ? { enabled } : {}),
                ...(typeof sound === "boolean" ? { sound } : {}),
            };
        } catch {
            return {};
        }
    }

    private writePrefs(change: { enabled?: boolean; sound?: boolean }): void {
        const next = { ...this.readPrefs(), ...this.memoryPrefs, ...change };
        try {
            if (!this.env.storage) throw new Error("no storage");
            this.env.storage.setItem(PREFS_KEY, JSON.stringify(next));
            this.memoryPrefs = {};
        } catch {
            this.memoryPrefs = next;
        }
    }

    private computeSnapshot(): DesktopNotificationsState {
        const api = this.env.Notification;
        const permission: NotificationPermissionState = api ? api.permission : "unsupported";
        const prefs = { ...this.readPrefs(), ...this.memoryPrefs };
        // Unset means on once the browser allows it: allowing is the user's own choice.
        return {
            permission,
            enabled: permission === "granted" && prefs.enabled !== false,
            sound: prefs.sound !== false,
        };
    }

    private refresh(): void {
        const next = this.computeSnapshot();
        const prev = this.snapshot;
        if (prev.permission === next.permission && prev.enabled === next.enabled && prev.sound === next.sound) return;
        this.snapshot = next;
        if (next.enabled && !prev.enabled && this.client.getSnapshot().connection === "online")
            void this.loadSettings();
        for (const listener of this.listeners) listener();
    }
}

function parseCoordinatorId(raw: unknown): string | null {
    if (!raw || typeof raw !== "object") return null;
    const id = (raw as Record<string, unknown>).convo_id;
    return typeof id === "string" && id ? id : null;
}

const notifiers = new WeakMap<MatronJournalClient, DesktopNotifier>();

/** The one notifier for a client (the app starts it; Settings reads and drives it). */
export function notificationsFor(client: MatronJournalClient): DesktopNotifier {
    let notifier = notifiers.get(client);
    if (!notifier) {
        notifier = new DesktopNotifier(client);
        notifiers.set(client, notifier);
    }
    return notifier;
}
