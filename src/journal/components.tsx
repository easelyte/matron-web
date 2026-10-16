/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, {
    type FormEvent,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useReducer,
    useState,
    useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./use-focus-trap";

import matronLogo from "../../res/matron-logo-simple.svg";
import {
    AgentSpawnCard,
    isAnswerableAgentSpawn,
    PROMPT_REPLY_CONFIRMATION_TIMEOUT_MS,
    PromptTerminalGlyph,
} from "./agent-spawn-card";
import { INITIAL_SGR_STATE, parseAnsi, stripLeadingSgrFragment } from "./ansi";
import {
    agentChatAnswersScope,
    agentChatCardKey,
    agentChatFromLabel,
    agentChatHeadline,
    agentChatToLabel,
    type AgentChatDecision,
    type AgentChatRequest,
    type AgentChatResolution,
    isAgentChatPayload,
    parseAgentChatRequest,
    readAgentChatResolutions,
    rememberAgentChatAnswer,
    rememberedAgentChatAnswer,
    type RememberedAgentChatAnswer,
    unanswerableAgentRequestNotice,
} from "./agent-chat";
import { isMediaExpiredError, JournalApiError } from "./api";
import {
    type AgentProbe,
    errorMessage,
    type MatronJournalClient,
    PREFERENCES_UNAVAILABLE_ERROR,
    workerKind,
} from "./client";
import { copyText } from "./clipboard";
import { type DraftStore, makeDraftStore } from "./composer-drafts";
import { isImeComposing, isSendKey, useAutoGrow } from "./composer-input";
import { SentMessageHistory } from "./sent-history";
import { effectiveUnread } from "./conversation-flags";
import { chipHeadline, chipLabel, isEarlierLink, linkLine, missionSections } from "./conversation-missions";
import { type RowContextMenu, useRowContextMenu } from "./context-menu";
import {
    coordinatorBadgeText,
    type CoordinatorDecision,
    readCoordinatorDecisions,
    stopSpawnedSession,
} from "./coordinator-consent";
import { CompactNudge } from "./compact-nudge";
import { CoordinatorEventNotice, isUnrenderableNoticeEvent } from "./coordinator-notices";
import {
    isSystemNoticeEvent,
    sameTimelineSection as sameSection,
    systemNotice,
    type SystemNotice,
} from "./system-notice";
import { dateTimeFormat } from "./date-format";
import { ChatTasksPane, CoordinatorChooserSheet, RoutinesSheet, SettingsSheet, TrackerPane } from "./deferred-ui";
import { FOCUS_HIGHLIGHT_MS, focusScrollTop, jumpToLastOwnShortcutLabel, landingSeq } from "./jump-to-message";
import { FindInChatBar, useFindInChatShortcut } from "./find-in-chat";
import { GoToNumberDialog, goToNumberShortcutLabel, NumberSearchResult, useGoToNumberShortcut } from "./goto-number";
import { PinDialog, type PinDialogTarget } from "./PinDialogs";
import { CommandPalette } from "./CommandPalette";
import { shortcutLabel, useAppShortcuts, useShortcutCommand } from "./shortcuts";
import { pinGlyph, successorHintText } from "./pins";
import {
    AnthropicMark,
    ArchiveIcon,
    ComposeIcon,
    ArrowUpToLineIcon,
    CheckIcon,
    ChevronDownIcon,
    ChevronLeftIcon,
    ChevronUpIcon,
    ChecklistIcon,
    ClipboardIcon,
    CloseIcon,
    CodeBracketsIcon,
    CompactIcon,
    ArchiveFileIcon,
    AudioFileIcon,
    FileEditIcon,
    FileIcon,
    FailedIcon,
    ImageFileIcon,
    InactiveIcon,
    InterruptedIcon,
    KebabIcon,
    MediaBrowserIcon,
    PdfFileIcon,
    TextFileIcon,
    VideoFileIcon,
    MarkdownIcon,
    MarkAllReadIcon,
    NumberSignIcon,
    MarkReadIcon,
    MarkUnreadIcon,
    OpenAIMark,
    PinIcon,
    SettingsIcon,
    StarFilledIcon,
    StarIcon,
    StopIcon,
    UnarchiveIcon,
    CheckCircleIcon,
    XOctagonIcon,
    PlusCircleIcon,
    RefreshIcon,
    ArrowUpCircleIcon,
    ProjectsIcon,
} from "./icons";
import { FilesPane } from "./files/FilesPane";
import { SearchField } from "./search-field";
import { NAV_RAIL_WIDTH, NavRail, type NavKey } from "./NavRail";
import { isAgentRoomTitle, needsYouByConversation, projectsNeedsYou } from "./needs-you";
import { notificationsFor, unreadTotal as countUnread } from "./notifications";
import { ConvoNotifyBell, OverflowRoomsAndNotify, RoomsControl } from "./ChatHeaderRooms";
import { useDismissablePopover } from "./use-dismissable-popover";
import { displayTitle, TaggedTitle } from "./SessionTag";
import { groupByDay } from "./sidebar-groups";
import { observeSeenRows } from "./seen-tracker";
import { preloadDeferredUi } from "./lazy";
import { createLongPressController, type LongPressController } from "./longPress";

// True inside the packaged Electron desktop app (its preload injects window.electron). The Files
// pane is web/iOS-PWA only for Phase 1 — see FilesApi header + the gated entry button (F2).
function isElectronRuntime(): boolean {
    return typeof window !== "undefined" && Boolean((window as Window & { electron?: unknown }).electron);
}
import { MarkdownBody, markdownToPlainText } from "./markdown";
import { snippetText } from "./plain-text";
import { ConnectionBanner, mainSurfaceOpen } from "./mobile-shell";
import {
    EMPTY_ITEM_CARD_FOLD,
    foldItemCards,
    isRenderableItemMarker,
    type ItemCardFold,
    MemoryNotice,
    MilestoneCard,
    MissionNotice,
    renderItemMarker,
} from "./tracker/cards";
import { OpsPane } from "./ops/OpsPane";
import { needsUser } from "./tracker/format";
import { NeedsYouBadge } from "./tracker/glyphs";
import {
    isPreviewableMarkdown,
    MarkdownPreviewContext,
    MarkdownPreviewPanel,
    useMarkdownPreview,
    useMarkdownPreviewPanel,
} from "./markdown-preview";
import { MediaBrowserSheet } from "./media-browser";
import { paneCoversChat, SubChatPane, type SubChatRow, useChatArea } from "./subchat-pane";
import { chatSidePane, subtaskDescription } from "./subtask";
import { SubtaskLine } from "./subtask-link";
import {
    buildMediaCorpus,
    isRenderableInViewer,
    type MediaItem,
    mediaRenderKind,
    MediaViewer,
    MediaViewerContext,
    type MediaViewerContextValue,
    useMediaViewer,
    useRenderableObjectUrl,
} from "./media-viewer";
import {
    applyArgument,
    applyCommand,
    applyFolder,
    type ArgSuggestion,
    argSuggestions,
    type BotCommand,
    CLAUDE_BRIDGE_COMMANDS,
    filterCommands,
    folderSuggestions,
    isCommandMode,
    makeRecentFoldersStore,
    recentFolderArgument,
} from "./slash-palette";
import { conversationSummary } from "./summary";
import { useShowTheWork } from "./show-the-work";
import { assembleTurns, isOperatorEvent, liveTurnOf, type Turn, threadRows, type ThreadRow } from "./turn-assembly";
import { noticeText, TurnCard, type TurnCardMode, TurnErrorRow } from "./turn-card";
import { V6Icon } from "./v6-icons";
import { applyPaneBand } from "./pane-width";
import { BoxUsage, NewSessionSheet as OneTapNewSessionSheet } from "./new-session-ui";
import {
    BROWSER_RESTART_COMMAND,
    BROWSER_RESTART_NOW_COMMAND,
    browserRestartNoticeSeqs,
    browserToolsState,
    type BrowserToolsState,
} from "./browser-tools";
import { type Step, stepSentence, stepsOf } from "./turn-grouping";
import { helperForStep, helpersByTurn, SubagentCard } from "./subagent-card";
import { HeadlineList } from "./headline-list";
import { previewLine } from "./activity-text";
import {
    compactTokens,
    formatSampleAge,
    isSampleStale,
    modelLine,
    normalizePercent,
    resetDisplay,
    sampleAgeMs,
    usageAccessibleLabel,
    usageShortLabel,
    usageOrderRank,
    usageLevel,
    worstLimit,
} from "./status";
import {
    asNumber,
    asString,
    buildSidebarIndex,
    childrenByParent,
    childrenOf,
    childSidebarPlacement,
    type ClientState,
    type ComposerAttachment,
    type MessageSearchState,
    type SearchHit,
    type Conversation,
    type ConversationMissionLink,
    type ConvoPin,
    conversationTitle,
    type DeviceDTO,
    displaySender,
    eventSnippet,
    type EventPayload,
    hasSubagentChildRows,
    type FileKind,
    fileKindFromMime,
    type HostVitals,
    IMAGE_FRAME_MAX_HEIGHT_PX,
    imageFrameStyle,
    isNearBottom,
    type MediaDims,
    mediaFileName,
    parseMediaDims,
    PEER_BODY_CAP,
    PEER_NAME_CAP,
    type JournalEvent,
    type PendingMessage,
    type NewSessionOffer,
    type StartOption,
    type StartSessionPicks,
    rendersAsTopLevelRow,
    sanitizePeerText,
    isSubChat,
    type SessionStatus,
    spawnOutcomeKind,
    spawnOutcomeSnippet,
    type ToolStreamState,
    normalizeServerUrl,
} from "./types";
import {
    useVoiceNoteBarVisible,
    useVoiceRecorder,
    VoiceErrorBanner,
    VoiceMicButton,
    VoiceNoteBar,
    type VoiceRecordingContext,
    VoiceRecordingBar,
} from "./voice-recorder";
import { voiceNoteSessionFor } from "./voice-note-session";
import { type ListPlace, useWindowedList } from "./windowing";

const NAV_VIEW = { projects: "missions", decisions: "inbox", memories: "memories" } as const;
const NAV_KEY_FOR_VIEW: Record<"missions" | "inbox" | "memories" | "work", NavKey> = {
    missions: "projects",
    inbox: "decisions",
    memories: "memories",
    work: "projects",
};
const LEFT_PANEL_SIZE_KEY = "matron_sidebar_width";
// The key earlier versions stored the width under; moved to the current key on first read.
const LEGACY_LEFT_PANEL_SIZE_KEY = "mx_lhs_size";
const LEFT_PANEL_DEFAULT_WIDTH = 350;
const LEFT_PANEL_MIN_WIDTH = 224;

function clampLeftPanelWidth(width: number, containerWidth: number): number {
    return Math.min(Math.max(width, LEFT_PANEL_MIN_WIDTH), Math.max(LEFT_PANEL_MIN_WIDTH, containerWidth / 2));
}

function initialLeftPanelWidth(): number {
    let storedWidth = Number.NaN;
    try {
        const legacy = window.localStorage.getItem(LEGACY_LEFT_PANEL_SIZE_KEY);
        if (legacy !== null) {
            if (window.localStorage.getItem(LEFT_PANEL_SIZE_KEY) === null) {
                window.localStorage.setItem(LEFT_PANEL_SIZE_KEY, legacy);
            }
            window.localStorage.removeItem(LEGACY_LEFT_PANEL_SIZE_KEY);
        }
        storedWidth = Number.parseInt(window.localStorage.getItem(LEFT_PANEL_SIZE_KEY) ?? "", 10);
    } catch {
        // Storage can be unavailable; the default width remains usable.
    }
    return clampLeftPanelWidth(
        Number.isFinite(storedWidth) && storedWidth >= LEFT_PANEL_MIN_WIDTH ? storedWidth : LEFT_PANEL_DEFAULT_WIDTH,
        // The stored width is the list's; the fixed nav rail sits beside it.
        document.documentElement.clientWidth - NAV_RAIL_WIDTH,
    );
}

function useLeftPanelResize(): {
    width: number;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
} {
    const [width, setWidth] = useState(initialLeftPanelWidth);
    const widthRef = useRef(width);
    const stopDraggingRef = useRef<() => void>(() => undefined);

    useEffect(() => {
        widthRef.current = width;
    }, [width]);

    useEffect(() => {
        const clampToWindow = (): void => {
            const nextWidth = clampLeftPanelWidth(
                widthRef.current,
                document.documentElement.clientWidth - NAV_RAIL_WIDTH,
            );
            widthRef.current = nextWidth;
            setWidth(nextWidth);
        };
        window.addEventListener("resize", clampToWindow);
        return () => {
            window.removeEventListener("resize", clampToWindow);
            stopDraggingRef.current();
        };
    }, []);

    const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) return;
        event.preventDefault();

        const container = event.currentTarget.parentElement;
        if (!container) return;
        const containerLeft = container.getBoundingClientRect().left;

        const stopDragging = (): void => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            try {
                window.localStorage.setItem(LEFT_PANEL_SIZE_KEY, String(Math.round(widthRef.current)));
            } catch {
                // Resizing remains available for the current session without persistence.
            }
            stopDraggingRef.current = () => undefined;
        };
        const onPointerMove = (moveEvent: PointerEvent): void => {
            const nextWidth = clampLeftPanelWidth(
                moveEvent.clientX - containerLeft - NAV_RAIL_WIDTH,
                container.clientWidth - NAV_RAIL_WIDTH,
            );
            widthRef.current = nextWidth;
            setWidth(nextWidth);
        };

        stopDraggingRef.current();
        stopDraggingRef.current = stopDragging;
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);
    }, []);

    return { width, onPointerDown };
}

/** A group break inside a menu (before Archive, Sign out, View source): one full-bleed hairline. */
export function MenuSeparator(): React.ReactElement {
    return <div className="mj_MenuSeparator" role="separator" />;
}

function formatTime(timestamp: number): string {
    return dateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

/**
 * A formatRelativeDay that builds each Intl.DateTimeFormat at most once. Constructing a formatter
 * is by far the costliest part of the label, and the sidebar formats one per row on every render
 * (thousands on an account with a long history), so ConversationList makes one of these per
 * render and shares it across rows. Per render, not module-level: the formatters capture the
 * time zone and locale at construction, so a long-lived cache would keep stale ones.
 */
export function makeRelativeDayFormatter(): (timestamp: number, now: number) => string {
    let clock: Intl.DateTimeFormat | undefined;
    let weekday: Intl.DateTimeFormat | undefined;
    let dayMonth: Intl.DateTimeFormat | undefined;
    let dayMonthYear: Intl.DateTimeFormat | undefined;
    return (timestamp, now) => {
        if (!Number.isFinite(timestamp)) return ""; // Non-finite → no throw, empty string.
        const then = new Date(timestamp);
        if (Number.isNaN(then.getTime())) return ""; // Invalid Date → Intl.format would throw; bail.
        const today = new Date(now);
        const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const dayMs = 86_400_000;
        const daysAgo = Math.round((startOf(today) - startOf(then)) / dayMs);
        if (daysAgo === 0) {
            // Today (including same-day minor-future skew) → clock.
            clock ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
            return clock.format(then);
        }
        if (daysAgo >= 1 && daysAgo <= 6) {
            weekday ??= new Intl.DateTimeFormat(undefined, { weekday: "short" });
            return weekday.format(then);
        }
        // Older than six days or a genuinely future calendar day falls through to a dated label.
        if (then.getFullYear() === today.getFullYear()) {
            dayMonth ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
            return dayMonth.format(then);
        }
        dayMonthYear ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
        return dayMonthYear.format(then);
    };
}

// EXPORTED: the render callsite uses it, and unit tests import it directly to inject `now`.
// `formatTime` stays private; only this helper needs the test seam.
export function formatRelativeDay(timestamp: number, now: number = Date.now()): string {
    return makeRelativeDayFormatter()(timestamp, now);
}

// formatRelativeDay for the sidebar, which labels every row on each render: a label depends only
// on the timestamp and today's date, so labels are kept until the day changes.
const relativeDayLabels = { day: NaN, labels: new Map<number, string>() };
export function relativeDayLabel(timestamp: number, now: number): string {
    const today = new Date(now);
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (day !== relativeDayLabels.day) {
        relativeDayLabels.day = day;
        relativeDayLabels.labels.clear();
    }
    let label = relativeDayLabels.labels.get(timestamp);
    if (label === undefined) {
        label = formatRelativeDay(timestamp, now);
        relativeDayLabels.labels.set(timestamp, label);
    }
    return label;
}

// True when two epoch-ms timestamps fall on the same local calendar day.
export function sameCalendarDay(a: number, b: number): boolean {
    const left = new Date(a);
    const right = new Date(b);
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
}

// Timeline day-divider label: a relative word (Today / Yesterday / weekday within the week)
// joined to an absolute date ("Today · 24 July"), so a scrolled-back reader always has both
// the human anchor and the exact date. EXPORTED for unit tests (inject `now`).
export function formatDayDivider(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp)) return "";
    const then = new Date(timestamp);
    if (Number.isNaN(then.getTime())) return "";
    const today = new Date(now);
    const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const daysAgo = Math.round((startOf(today) - startOf(then)) / 86_400_000);
    const sameYear = then.getFullYear() === today.getFullYear();
    const dateStr = dateTimeFormat(
        undefined,
        sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" },
    ).format(then);
    let word: string | undefined;
    if (daysAgo === 0) word = "Today";
    else if (daysAgo === 1) word = "Yesterday";
    else if (daysAgo >= 2 && daysAgo <= 6) word = dateTimeFormat(undefined, { weekday: "long" }).format(then);
    return word ? `${word} · ${dateStr}` : dateStr;
}

function formatBytes(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function LoginScreen({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    // unify step 2: the Mac sign-in layout — one column, labels above fields, submit disabled
    // until the form is valid. When config.json fixes the server the field is hidden and the
    // host is named under the title instead.
    const fixedServer = state.config.journal_server_url?.trim() || undefined;
    const [server, setServer] = useState(client.suggestedServer());
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(state.connectionError);

    const effectiveServer = fixedServer ?? server;
    const canSubmit = !busy && effectiveServer.trim() !== "" && username.trim() !== "" && password !== "";
    const brand = state.config.brand || "Matron";

    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        if (!canSubmit) return;
        setBusy(true);
        setError(undefined);
        try {
            await client.login(effectiveServer, username, password);
        } catch (loginError) {
            setError(errorMessage(loginError));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mj_Login">
            <main className="mj_Login_column">
                <img className="mj_Login_logo" src={matronLogo} alt={brand} />
                <h1 className="mj_Login_title">Sign in to {brand}</h1>
                {fixedServer && <p className="mj_LoginServerNote">Signing in to {hostLabel(fixedServer)}</p>}
                <form className="mj_LoginForm" onSubmit={(event) => void submit(event)}>
                    {!fixedServer && (
                        <label className="mj_LoginField" htmlFor="mj_LoginForm_server">
                            <span className="mj_LoginField_label">Server</span>
                            <input
                                id="mj_LoginForm_server"
                                type="text"
                                inputMode="url"
                                value={server}
                                onChange={(event) => setServer(event.target.value)}
                                placeholder="https://your-server.example.com"
                                autoComplete="url"
                                autoCorrect="off"
                                autoCapitalize="none"
                                required
                                autoFocus
                            />
                        </label>
                    )}
                    <label className="mj_LoginField" htmlFor="mj_LoginForm_username">
                        <span className="mj_LoginField_label">Username</span>
                        <input
                            id="mj_LoginForm_username"
                            type="text"
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder="alice"
                            autoComplete="username"
                            autoCorrect="off"
                            autoCapitalize="none"
                            required
                            autoFocus={Boolean(fixedServer)}
                        />
                    </label>
                    <label className="mj_LoginField" htmlFor="mj_LoginForm_password">
                        <span className="mj_LoginField_label">Password</span>
                        <input
                            id="mj_LoginForm_password"
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                    {error && (
                        <div className="mj_Error mj_Login_error" role="alert">
                            {error}
                        </div>
                    )}
                    <button className="mj_LoginSubmit" type="submit" disabled={!canSubmit}>
                        {busy ? "Signing in…" : "Sign in"}
                    </button>
                </form>
                {state.config.privacy_policy_url && (
                    <a
                        className="mj_PrivacyLink"
                        href={state.config.privacy_policy_url}
                        target="_blank"
                        rel="noreferrer"
                    >
                        Privacy policy
                    </a>
                )}
            </main>
        </div>
    );
}

/** Host shown under the sign-in title when the deployment fixes the server: "chat.example.com". */
function hostLabel(url: string): string {
    // normalizeServerUrl resolves the deployment's relative "/" or "/journal" against the page
    // origin, the same way client.login does, so the note names the real host.
    try {
        return new URL(normalizeServerUrl(url)).host;
    } catch {
        return url;
    }
}

type SheetState =
    | { step: "loading-agents" }
    | { step: "agents-error" }
    | { step: "agents"; agents: DeviceDTO[] }
    | {
          step: "folders";
          agent: DeviceDTO;
          foldersRequestId: number;
          offer?: NewSessionOffer;
          foldersError?: string;
      }
    | { step: "starting"; agent: DeviceDTO }
    | { step: "uncertain" }
    // The box's offer rides along so Retry sends the same picks, and Change options can go back
    // to the form to pick another.
    | { step: "error"; agent: DeviceDTO; message: string; offer?: NewSessionOffer };

// The sheet's own agent, model and effort picks. null = no pick: the box's default applies.
interface SheetPicks {
    agent: string | null;
    model: string | null;
    effort: string | null;
}

const NO_PICKS: SheetPicks = { agent: null, model: null, effort: null };

const EMPTY_OFFER: NewSessionOffer = {
    folders: [],
    agentOptions: [],
    defaultAgent: null,
    modelOptions: [],
    defaultModel: null,
    effortOptions: [],
    defaultEffort: null,
};

const CLAUDE_AGENT = "claude";

function offers(options: StartOption[], value: string | null): value is string {
    return value !== null && options.some((option) => option.value === value);
}

// The agent `start` names: the pick when this box offers it, else the box's default, else its
// first offer. Reads as Claude on a bridge that offers none, which is what such a bridge runs.
function selectedAgent(offer: NewSessionOffer, picks: SheetPicks): string {
    if (offers(offer.agentOptions, picks.agent)) return picks.agent;
    if (offers(offer.agentOptions, offer.defaultAgent)) return offer.defaultAgent;
    return offer.agentOptions[0]?.value ?? CLAUDE_AGENT;
}

// A pick this box doesn't list is dropped, not parked: carried to the next box it would be a
// `bad_model` (or `bad_agent`, `bad_effort`) waiting to happen.
function prunePicks(offer: NewSessionOffer, picks: SheetPicks): SheetPicks {
    return {
        agent: offers(offer.agentOptions, picks.agent) ? picks.agent : null,
        model: offers(offer.modelOptions, picks.model) ? picks.model : null,
        effort: offers(offer.effortOptions, picks.effort) ? picks.effort : null,
    };
}

function startPicks(offer: NewSessionOffer | undefined, picks: SheetPicks): StartSessionPicks {
    if (!offer) return {};
    const result: StartSessionPicks = {};
    const agent = selectedAgent(offer, picks);
    // Named whenever the box offered agents, even its default: saying what was shown beats
    // trusting the box default not to have moved since. A bridge that offered none isn't told.
    if (offer.agentOptions.length > 0) result.agent = agent;
    // Model and effort are Claude's: a Codex session takes neither, and the bridge refuses one.
    // No pick omits the key, so the box's own default (the user's, else the box's) applies.
    if (agent === CLAUDE_AGENT) {
        if (offers(offer.modelOptions, picks.model)) result.model = picks.model;
        if (offers(offer.effortOptions, picks.effort)) result.effort = picks.effort;
    }
    return result;
}

// The nil row's title: "Default (Opus)" on a box that names its default, plain "Default" else.
function defaultRowTitle(options: StartOption[], value: string | null): string {
    if (value === null) return "Default";
    return `Default (${options.find((option) => option.value === value)?.label ?? value})`;
}

// A recent folder's caption: how long since a session last started there. last_used is epoch ms;
// null is the bridge's default folder on a box that has never started one.
function folderLastUsed(lastUsed: number | null, now: number): string {
    return lastUsed === null ? "Never used" : formatSampleAge(Math.max(0, now - lastUsed));
}

// What an offline box's row says while its Wake button is at work. Absent = not being woken.
type RowWake = "waking" | "failed";

// The wake loop re-asks a booting box this often, and gives up after this many asks or this long.
const WAKE_RETRY_DELAY_MS = 3_000;
const WAKE_ATTEMPT_LIMIT = 40;
const WAKE_DEADLINE_MS = 120_000;

function agentName(agent: DeviceDTO): string {
    return agent.name?.trim() || `Agent ${agent.device_id}`;
}

function agentStatus(agent: DeviceDTO, wake?: RowWake): string {
    if (agent.connected) return "Connected";
    if (wake === "waking") return "Waking…";
    if (wake === "failed") return "Didn't wake — try again";
    if (agent.last_seen_at === undefined) return "Offline · last seen unknown";
    const timestamp = agent.last_seen_at < 1_000_000_000_000 ? agent.last_seen_at * 1000 : agent.last_seen_at;
    return `Offline · last seen ${new Date(timestamp).toLocaleString()}`;
}

/** "New coordinator chat…" starts the session on this model, as on the Mac. */
const COORDINATOR_NEW_CHAT_MODEL = "opus[1m]";

export function NewSessionSheet({
    client,
    onClose,
    title = "New session",
    initialModel,
    onCreated,
}: {
    client: MatronJournalClient;
    onClose: () => void;
    title?: string;
    /** A model picked up front (the Coordinator chooser's new chat); dropped on a box without it. */
    initialModel?: string;
    /** Called with the new conversation once the box created it, after it is opened. */
    onCreated?: (convoId: string) => void;
}): React.ReactElement {
    const [sheetState, setSheetState] = useState<SheetState>({ step: "loading-agents" });
    const boxStatuses = useSyncExternalStore(client.subscribe, () => client.getSnapshot().boxStatuses);
    const now = useMinuteClock();
    const [workdir, setWorkdir] = useState("");
    const [browserTools, setBrowserTools] = useState(false);
    const [picks, setPicks] = useState<SheetPicks>(() =>
        initialModel ? { ...NO_PICKS, model: initialModel } : NO_PICKS,
    );
    const [showBack, setShowBack] = useState(false);
    const sheetStateRef = useRef(sheetState);
    const agentsRef = useRef<DeviceDTO[]>([]);
    const agentsRequestIdRef = useRef(0);
    const foldersRequestIdRef = useRef(0);
    const startingRef = useRef(false);
    const mountedRef = useRef(false);
    const dismissedRef = useRef(false);
    const [rowWakes, setRowWakes] = useState<Record<number, RowWake>>({});
    const wakingRef = useRef(new Set<number>());

    const transition = useCallback((next: SheetState): void => {
        sheetStateRef.current = next;
        setSheetState(next);
    }, []);

    // Wakes an offline box from its row, without leaving the list. Each box runs its own loop,
    // so several can be woken at once; a loop carries on behind another box's folder step and
    // stops only when the sheet goes away. A box that answers turns "Connected" where it
    // stands: rows don't move under someone working down the list.
    const wake = useCallback(
        async (agent: DeviceDTO): Promise<void> => {
            const id = agent.device_id;
            if (wakingRef.current.has(id) || dismissedRef.current) return;
            wakingRef.current.add(id);
            setRowWakes((current) => ({ ...current, [id]: "waking" }));
            const gone = (): boolean => !mountedRef.current || dismissedRef.current;
            const began = Date.now();
            let outcome: AgentProbe = "booting";
            for (let attempt = 1; attempt <= WAKE_ATTEMPT_LIMIT; attempt += 1) {
                outcome = await client.probeAgent(id).catch((): AgentProbe => "failed");
                if (gone()) return;
                if (outcome !== "booting") break;
                if (attempt === WAKE_ATTEMPT_LIMIT || Date.now() - began >= WAKE_DEADLINE_MS) break;
                await new Promise((resolve) => window.setTimeout(resolve, WAKE_RETRY_DELAY_MS));
                if (gone()) return;
            }
            wakingRef.current.delete(id);
            if (outcome !== "up") {
                setRowWakes((current) => ({ ...current, [id]: "failed" }));
                return;
            }
            setRowWakes(({ [id]: _woken, ...rest }) => rest);
            agentsRef.current = agentsRef.current.map((candidate) =>
                candidate.device_id === id ? { ...candidate, connected: true } : candidate,
            );
            const current = sheetStateRef.current;
            if (current.step === "agents") transition({ step: "agents", agents: agentsRef.current });
        },
        [client, transition],
    );

    const loadFolders = useCallback(
        (agent: DeviceDTO, backAvailable: boolean): void => {
            const foldersRequestId = ++foldersRequestIdRef.current;
            setShowBack(backAvailable);
            transition({ step: "folders", agent, foldersRequestId });
            void client.newSessionOffer(agent.device_id).then(
                (offer) => {
                    const current = sheetStateRef.current;
                    if (
                        !mountedRef.current ||
                        dismissedRef.current ||
                        current.step !== "folders" ||
                        current.agent.device_id !== agent.device_id ||
                        current.foldersRequestId !== foldersRequestId
                    ) {
                        return;
                    }
                    setPicks((current) => prunePicks(offer, current));
                    transition({ ...current, offer });
                },
                () => {
                    const current = sheetStateRef.current;
                    if (
                        !mountedRef.current ||
                        dismissedRef.current ||
                        current.step !== "folders" ||
                        current.agent.device_id !== agent.device_id ||
                        current.foldersRequestId !== foldersRequestId
                    ) {
                        return;
                    }
                    transition({ ...current, offer: EMPTY_OFFER, foldersError: "Couldn't load recent folders." });
                },
            );
        },
        [client, transition],
    );

    const loadAgents = useCallback((): void => {
        const agentsRequestId = ++agentsRequestIdRef.current;
        transition({ step: "loading-agents" });
        void client.listAgents().then(
            (agents) => {
                if (!mountedRef.current || dismissedRef.current || agentsRequestId !== agentsRequestIdRef.current) {
                    return;
                }
                agentsRef.current = agents;
                // Only a fleet of one skips the list. One box awake among sleeping ones is the
                // usual state, and skipping to it would leave the others with no row to wake from.
                if (agents.length === 1 && agents[0].connected) {
                    loadFolders(agents[0], false);
                } else {
                    setShowBack(true);
                    transition({ step: "agents", agents });
                }
            },
            () => {
                if (mountedRef.current && !dismissedRef.current && agentsRequestId === agentsRequestIdRef.current) {
                    transition({ step: "agents-error" });
                }
            },
        );
    }, [client, loadFolders, transition]);

    useEffect(() => {
        mountedRef.current = true;
        loadAgents();
        return () => {
            mountedRef.current = false;
        };
    }, [loadAgents]);

    const dismiss = (): void => {
        dismissedRef.current = true;
        onClose();
    };

    const start = async (agent: DeviceDTO, path = workdir, browser = browserTools): Promise<void> => {
        if (startingRef.current || dismissedRef.current) return;
        const current = sheetStateRef.current;
        const offer =
            (current.step === "folders" || current.step === "error") && current.agent.device_id === agent.device_id
                ? current.offer
                : undefined;
        startingRef.current = true;
        transition({ step: "starting", agent });
        const outcome = await client.startSessionRpc(agent.device_id, path, browser, startPicks(offer, picks));
        if (!mountedRef.current || dismissedRef.current) return;
        if (outcome.kind === "created") {
            dismissedRef.current = true;
            onClose();
            void client.selectConversation(outcome.convoId, { fromRpcCreate: true });
            onCreated?.(outcome.convoId);
            return;
        }
        if (outcome.kind === "uncertain") {
            transition({ step: "uncertain" });
            return;
        }
        startingRef.current = false;
        transition({ step: "error", agent, message: outcome.message, offer });
    };

    const folderState = sheetState.step === "folders" ? sheetState : undefined;
    const offer = folderState?.offer;
    const agentPick = offer ? selectedAgent(offer, picks) : CLAUDE_AGENT;
    // One choice is no choice: the switch shows only with a second agent to switch to. The model
    // and effort pickers hide for a box that offers none (an older bridge, or one whose default
    // agent is Codex) and while Codex is picked.
    const agentSwitchVisible = (offer?.agentOptions.length ?? 0) > 1;
    const modelPickerVisible = offer !== undefined && offer.modelOptions.length > 0 && agentPick === CLAUDE_AGENT;
    const effortPickerVisible = offer !== undefined && offer.effortOptions.length > 0 && agentPick === CLAUDE_AGENT;

    const trapRef = useRef<HTMLDivElement>(null);
    useFocusTrap(trapRef);
    return (
        <div
            ref={trapRef}
            className="mj_UploadConfirm_scrim"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mj-new-session-title"
        >
            <div className="mj_UploadConfirm mj_NewSessionSheet">
                <div className="mj_NewSessionSheet_head">
                    <h2 className="mj_UploadConfirm_title" id="mj-new-session-title">
                        {title}
                    </h2>
                    <button type="button" className="mj_NewSessionSheet_close" aria-label="Close" onClick={dismiss}>
                        <svg
                            viewBox="0 0 24 24"
                            width="16"
                            height="16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {sheetState.step === "loading-agents" && (
                    <div role="status">
                        <span className="mj_Spinner" aria-hidden="true" /> Loading agents…
                    </div>
                )}

                {sheetState.step === "agents-error" && (
                    <>
                        <p className="mj_UploadConfirm_error">Couldn't load agents.</p>
                        <div className="mj_UploadConfirm_actions">
                            <button type="button" className="mj_UploadConfirm_send" onClick={loadAgents}>
                                Retry
                            </button>
                        </div>
                    </>
                )}

                {sheetState.step === "agents" && (
                    <>
                        {sheetState.agents.length === 0 ? (
                            <p>No agents connected — start the bridge on your box.</p>
                        ) : (
                            <div role="list" aria-label="Agents">
                                {sheetState.agents.map((agent) => {
                                    const rowWake = agent.connected ? undefined : rowWakes[agent.device_id];
                                    return (
                                        <div
                                            key={agent.device_id}
                                            role="listitem"
                                            className="mj_NewSessionSheet_agentRow"
                                        >
                                            <button
                                                type="button"
                                                className="mj_NewSessionSheet_agent"
                                                disabled={!agent.connected}
                                                onClick={() => loadFolders(agent, true)}
                                            >
                                                <strong>{agentName(agent)}</strong>
                                                <span role={rowWake ? "status" : undefined}>
                                                    {agentStatus(agent, rowWake)}
                                                </span>
                                                <BoxUsage status={boxStatuses[agent.device_id]} now={now} />
                                            </button>
                                            {rowWake === "waking" ? (
                                                <span
                                                    className="mj_Spinner mj_NewSessionSheet_waking"
                                                    aria-hidden="true"
                                                />
                                            ) : (
                                                !agent.connected && (
                                                    <button
                                                        type="button"
                                                        className="mj_NewSessionSheet_wake"
                                                        aria-label={`Wake ${agentName(agent)}`}
                                                        onClick={() => void wake(agent)}
                                                    >
                                                        Wake
                                                    </button>
                                                )
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {folderState && (
                    <>
                        <p>Start on {agentName(folderState.agent)}</p>
                        <BoxUsage status={boxStatuses[folderState.agent.device_id]} now={now} />
                        {offer === undefined ? (
                            <div role="status">
                                <span className="mj_Spinner" aria-hidden="true" /> Loading recent folders…
                            </div>
                        ) : (
                            offer.folders.length > 0 && (
                                <div role="list" aria-label="Recent folders">
                                    {offer.folders.map((folder) => (
                                        <button
                                            key={folder.path}
                                            type="button"
                                            role="listitem"
                                            className="mj_NewSessionSheet_folder"
                                            onClick={() => {
                                                setWorkdir(folder.path);
                                                void start(folderState.agent, folder.path, browserTools);
                                            }}
                                        >
                                            <span className="mj_NewSessionSheet_folderPath">{folder.path}</span>
                                            <span className="mj_NewSessionSheet_folderUsed">
                                                {folderLastUsed(folder.last_used, now)}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )
                        )}
                        {folderState.foldersError && (
                            <p className="mj_UploadConfirm_error">{folderState.foldersError}</p>
                        )}
                        <label htmlFor="mj-new-session-workdir">Folder path</label>
                        <input
                            id="mj-new-session-workdir"
                            type="text"
                            value={workdir}
                            onChange={(event) => setWorkdir(event.target.value)}
                            placeholder="Agent default"
                        />
                        {offer && agentSwitchVisible && (
                            <div
                                className="mj_TrackerSegment mj_NewSessionSheet_agentSwitch"
                                role="group"
                                aria-label="Agent"
                            >
                                {offer.agentOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={agentPick === option.value}
                                        onClick={() => setPicks((current) => ({ ...current, agent: option.value }))}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        )}
                        {offer && (modelPickerVisible || effortPickerVisible) && (
                            <div className="mj_NewSessionSheet_picks">
                                {modelPickerVisible && (
                                    <div className="mj_NewSessionSheet_pick">
                                        <label htmlFor="mj-new-session-model">Model</label>
                                        <select
                                            id="mj-new-session-model"
                                            value={picks.model ?? ""}
                                            onChange={(event) =>
                                                setPicks((current) => ({
                                                    ...current,
                                                    model: event.target.value || null,
                                                }))
                                            }
                                        >
                                            <option value="">
                                                {defaultRowTitle(offer.modelOptions, offer.defaultModel)}
                                            </option>
                                            {offer.modelOptions.map((option) => (
                                                <option key={option.value} value={option.value}>
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                {effortPickerVisible && (
                                    <div className="mj_NewSessionSheet_pick">
                                        <label htmlFor="mj-new-session-effort">Effort</label>
                                        <select
                                            id="mj-new-session-effort"
                                            value={picks.effort ?? ""}
                                            onChange={(event) =>
                                                setPicks((current) => ({
                                                    ...current,
                                                    effort: event.target.value || null,
                                                }))
                                            }
                                        >
                                            <option value="">
                                                {defaultRowTitle(offer.effortOptions, offer.defaultEffort)}
                                            </option>
                                            {offer.effortOptions.map((option) => (
                                                <option key={option.value} value={option.value}>
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                        )}
                        <label>
                            <input
                                type="checkbox"
                                checked={browserTools}
                                onChange={(event) => setBrowserTools(event.target.checked)}
                            />{" "}
                            Browser tools
                        </label>
                        <div className="mj_UploadConfirm_actions">
                            {showBack && (
                                <button
                                    type="button"
                                    onClick={() => transition({ step: "agents", agents: agentsRef.current })}
                                >
                                    Back
                                </button>
                            )}
                            <button
                                type="button"
                                className="mj_UploadConfirm_send"
                                onClick={() => void start(folderState.agent)}
                            >
                                Start
                            </button>
                        </div>
                    </>
                )}

                {sheetState.step === "starting" && (
                    <div role="status">
                        <span className="mj_Spinner" aria-hidden="true" /> Starting session…
                    </div>
                )}

                {sheetState.step === "uncertain" && (
                    <>
                        <p>The session may have started. Check your conversations before trying again.</p>
                        <div className="mj_UploadConfirm_actions">
                            <button type="button" onClick={dismiss}>
                                Close
                            </button>
                        </div>
                    </>
                )}

                {sheetState.step === "error" && (
                    <>
                        <p className="mj_UploadConfirm_error">{sheetState.message}</p>
                        <div className="mj_UploadConfirm_actions">
                            {sheetState.offer && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        transition({
                                            step: "folders",
                                            agent: sheetState.agent,
                                            foldersRequestId: foldersRequestIdRef.current,
                                            offer: sheetState.offer,
                                        })
                                    }
                                >
                                    Change options
                                </button>
                            )}
                            <button
                                type="button"
                                className="mj_UploadConfirm_send"
                                onClick={() => void start(sheetState.agent)}
                            >
                                Retry
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export function markForKind(kind: string | null | undefined, className?: string): React.ReactElement | null {
    const classes = [className, kind === "codex" ? "mj_OpenAIMark" : "mj_AnthropicMark"].filter(Boolean).join(" ");
    if (kind === "codex") return <OpenAIMark className={classes} />;
    if (kind === "claude") return <AnthropicMark className={classes} />;
    return null;
}

function WorkerMark({
    conversation,
    className,
}: {
    conversation: Conversation;
    className: string;
}): React.ReactElement | null {
    return markForKind(workerKind(conversation), className);
}

type OutcomeClassification = "running" | "completed" | "interrupted" | "failed" | "inactive";

function classifyOutcome(conversation: Conversation): OutcomeClassification {
    if (conversation.session_state === "running") return "running";
    if (conversation.session_state !== "done") return "inactive";
    if (conversation.session_outcome === "interrupted") return "interrupted";
    if (conversation.session_outcome === "failed") return "failed";
    if (conversation.session_outcome === "completed" || conversation.session_outcome == null) return "completed";
    return "inactive";
}

function accessibleOutcome(classification: OutcomeClassification): string {
    return classification === "inactive" ? "status unknown" : classification;
}

function OutcomeGlyph({
    conversation,
    className,
    spinnerClassName,
}: {
    conversation: Conversation;
    className: string;
    spinnerClassName?: string;
}): React.ReactElement {
    const classification = classifyOutcome(conversation);
    if (classification === "running") {
        return <span className={`mj_Spinner${spinnerClassName ? ` ${spinnerClassName}` : ""}`} aria-hidden="true" />;
    }
    if (classification === "interrupted") {
        return <InterruptedIcon className={`${className} mj_InterruptedGlyph`} />;
    }
    if (classification === "failed") {
        return <FailedIcon className={`${className} mj_FailedGlyph`} />;
    }
    if (classification === "completed") {
        return <CheckIcon className={`${className} mj_CompletedGlyph`} aria-hidden="true" />;
    }
    return <InactiveIcon className={`${className} mj_InactiveOutcomeGlyph`} />;
}

/**
 * A subagent row's status glyph, one per state in the v6 language: the turn card's spinner while
 * running, a check once completed, a cross when it failed, an amber dot when interrupted, a
 * muted dot when the state is unknown.
 */
function SubRowStatus({ conversation }: { conversation: Conversation }): React.ReactElement {
    const classification = classifyOutcome(conversation);
    return (
        <span
            className={`mj_ConversationListSubStatus mj_ConversationListSubStatus_${classification}`}
            aria-hidden="true"
        >
            {classification === "running" ? (
                <span className="mj_TurnCard_spinner" />
            ) : classification === "completed" ? (
                <V6Icon name="check" />
            ) : classification === "failed" ? (
                <V6Icon name="x" />
            ) : (
                <span className="mj_ConversationListSubStatus_dot" />
            )}
        </span>
    );
}

// Debounce keystrokes before firing a message-content search request.
const MESSAGE_SEARCH_DEBOUNCE_MS = 200;

/**
 * Render a server search snippet, turning its `**…**` match markers into <mark> highlights.
 * The snippet is plain text (server-escaped), so we only split on the markers — no HTML is
 * interpreted. Unbalanced markers degrade to literal text rather than swallowing the rest.
 */
export function renderSnippet(snippet: string): React.ReactNode[] {
    const parts = snippet.split("**");
    return parts.map((part, index) =>
        // Odd segments sat between a matched pair of markers → highlight. If the count is even
        // (a dangling marker), the trailing odd segment is still highlighted, which is harmless.
        index % 2 === 1 ? (
            <mark key={index} className="mj_SearchHit_mark">
                {part}
            </mark>
        ) : (
            <React.Fragment key={index}>{part}</React.Fragment>
        ),
    );
}

export function MessageSearchResults({
    query,
    search,
    now,
    onSelect,
}: {
    query: string;
    search: MessageSearchState | undefined;
    now: number;
    onSelect: (hit: SearchHit) => void;
}): React.ReactElement | null {
    // Only surface the section for a live query. `search` can lag the box by a debounce interval
    // or a stale query, so gate on the current box being non-empty AND the results being for it.
    const trimmed = query.trim();
    if (!trimmed || !search || search.query !== trimmed) return null;
    const { hits, loading, failed } = search;
    return (
        <div className="mj_SearchResults" data-testid="message-search-results">
            <div className="mj_SearchResults_heading" role="presentation">
                Messages
            </div>
            {failed ? (
                <p className="mj_ConversationListEmpty" role="status">
                    Search is unavailable right now.
                </p>
            ) : hits.length === 0 ? (
                // Hits are bound to their query, so an empty set while loading means the current
                // query has no results yet — show a searching state, never a prior query's rows.
                loading ? (
                    <p className="mj_ConversationListEmpty" role="status">
                        Searching…
                    </p>
                ) : (
                    <p className="mj_ConversationListEmpty" role="status">
                        No messages match your search.
                    </p>
                )
            ) : (
                <ul className="mj_SearchHitList" role="list" aria-label="Message search results">
                    {hits.map((hit) => (
                        <li key={`${hit.convo_id}:${hit.seq}`} role="listitem">
                            <button
                                type="button"
                                className="mj_SearchHit"
                                onClick={() => onSelect(hit)}
                                aria-label={`Open conversation ${hit.title || "Untitled"}`}
                            >
                                <span className="mj_SearchHit_top">
                                    <span className="mj_SearchHit_title">{hit.title || "Untitled"}</span>
                                    <span className="mj_SearchHit_time">{formatRelativeDay(hit.ts, now)}</span>
                                </span>
                                <span className="mj_SearchHit_snippet">{renderSnippet(hit.snippet)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** What a sidebar row does when used; one stable object for the whole list, so a row's props
 *  only change when what it shows changes. */
interface ConversationRowActions {
    open(conversationId: string, event: React.MouseEvent): void;
    contextMenu(conversationId: string, event: React.MouseEvent<HTMLButtonElement>): void;
    pointerDown(conversationId: string, event: React.PointerEvent<HTMLButtonElement>): void;
    pointerMove(event: React.PointerEvent): void;
    pointerUp(event: React.PointerEvent): void;
    pointerCancel(event: React.PointerEvent): void;
    menuTrigger(conversationId: string, element: HTMLButtonElement | null): void;
    menuButton(conversationId: string, event: React.MouseEvent<HTMLButtonElement>): void;
}

interface ConversationRowProps {
    conversation: Conversation;
    isSubagent: boolean;
    /** The last subagent row under its parent: the tree connector ends there. */
    isLastSubagent: boolean;
    /** The row's one-line preview (Developer view: the snippet's words; otherwise the activity). */
    preview: string;
    /** A journal pin row: the pin's glyph + label lead, the conversation's title goes secondary. */
    pin?: ConvoPin;
    selected: boolean;
    unread: boolean;
    overrideUnread: boolean;
    pinned: boolean;
    favorite: boolean;
    menuOpen: boolean;
    needsYou: number;
    isNew: boolean;
    timestamp: string;
    collapsedCount: number;
    collapsedUnread: boolean;
    agents: ClientState["agents"];
    actions: ConversationRowActions;
}

/** One sidebar row. Memoised: the list re-renders on every state change it does not ignore, and
 *  with a thousand rows re-rendering each one is most of the cost of switching conversation. */
const ConversationRow = React.memo(function ConversationRow({
    conversation,
    isSubagent,
    isLastSubagent,
    preview,
    pin,
    selected,
    unread,
    overrideUnread,
    pinned,
    favorite,
    menuOpen,
    needsYou,
    isNew,
    timestamp,
    collapsedCount,
    collapsedUnread,
    agents,
    actions,
}: ConversationRowProps): React.ReactElement {
    const name = pin ? pin.label : conversationTitle(conversation);
    const outcomeStatus = isSubagent ? accessibleOutcome(classifyOutcome(conversation)) : undefined;
    return (
        <div className="mj_ConversationListItem_wrapper" role="listitem">
            <button
                className={`mj_ConversationListItem${selected ? " mj_ConversationListItem_selected" : ""}${
                    isSubagent
                        ? ` mj_ConversationListItem_sub${isLastSubagent ? " mj_ConversationListItem_subLast" : ""}`
                        : ""
                }`}
                type="button"
                aria-current={selected ? "page" : undefined}
                aria-label={`Open ${isSubagent ? "subagent" : "room"} ${name}${outcomeStatus ? `, ${outcomeStatus}` : ""}, last activity ${timestamp}${isNew ? ", new session" : ""}${
                    needsYou > 0 ? `, ${needsYou} ${needsYou === 1 ? "item needs" : "items need"} you` : ""
                }${overrideUnread ? ", marked unread" : ""}${
                    collapsedCount > 0
                        ? `, ${collapsedCount} subagent${collapsedCount === 1 ? "" : "s"} hidden${collapsedUnread ? " (unread)" : ""}`
                        : ""
                }`}
                onClick={(event) => actions.open(conversation.id, event)}
                onContextMenu={(event) => actions.contextMenu(conversation.id, event)}
                onPointerDown={(event) => actions.pointerDown(conversation.id, event)}
                onPointerMove={actions.pointerMove}
                onPointerUp={actions.pointerUp}
                onPointerCancel={actions.pointerCancel}
            >
                {/* §118 leading-glyph precedence. Subagent rows show one status glyph (the v6
                    spinner while running, a check once done) on a tree connector from the
                    parent. Parent rows keep the shipped pin-or-status behaviour (star renders
                    separately before the meta). */}
                {isSubagent ? (
                    <SubRowStatus conversation={conversation} />
                ) : pin ? (
                    <span className="mj_ConversationListPinGlyph mj_PinGlyph" aria-hidden="true">
                        {pinGlyph(pin)}
                    </span>
                ) : pinned ? (
                    <span className="mj_ConversationListPinGlyph">
                        <PinIcon aria-hidden />
                    </span>
                ) : (
                    <span
                        className={`mj_ConversationListStatus mj_ConversationListStatus_${
                            conversation.session_state === "running" ? "running" : "idle"
                        }`}
                        aria-hidden="true"
                    />
                )}
                <span className={`mj_ConversationListText${unread ? " mj_ConversationListText_unread" : ""}`}>
                    <span className="mj_ConversationListName" title={name} data-testid="conversation-name">
                        {pin ? pin.label : <TaggedTitle conversation={conversation} agents={agents} />}
                    </span>
                    <span className="mj_ConversationListMeta" title={pin ? displayTitle(conversation) : preview}>
                        {pin ? (
                            <>
                                <span className="mj_ConversationListSnippet">
                                    <TaggedTitle conversation={conversation} agents={agents} />
                                </span>
                                <span className="mj_ConversationListDot"> · </span>
                            </>
                        ) : (
                            preview && (
                                <>
                                    <span
                                        className={`mj_ConversationListSnippet${isSubagent ? " mj_ConversationListPreview" : ""}`}
                                    >
                                        {preview}
                                    </span>
                                    <span className="mj_ConversationListDot"> · </span>
                                </>
                            )
                        )}
                        <span className="mj_ConversationListTime">{timestamp}</span>
                    </span>
                </span>
                {favorite && (
                    <span className="mj_ConversationListStarGlyph">
                        <StarFilledIcon aria-hidden />
                    </span>
                )}
                <span className="mj_ConversationListTrailing">
                    {collapsedCount > 0 && (
                        // Decorative: the hidden-child count + unread state are announced via the
                        // containing row button's aria-label (a nested label here would be silent to AT).
                        <span
                            className={`mj_ConversationListCollapsedSubs${
                                collapsedUnread ? " mj_ConversationListCollapsedSubs_unread" : ""
                            }`}
                            aria-hidden="true"
                        >
                            <ChevronLeftIcon aria-hidden />
                            {collapsedCount}
                            {collapsedUnread && <span className="mj_UnreadDot" aria-hidden />}
                        </span>
                    )}
                    {/* Mac order: New, then what needs you, then unread. Announced via the row's
                        aria-label, like the collapsed-children chip above. */}
                    {(isNew || needsYou > 0 || conversation.unread_count > 0 || overrideUnread) && (
                        <span className="mj_ConversationListBadges">
                            {isNew && (
                                <span className="mj_ConversationListNew" aria-hidden="true">
                                    New
                                </span>
                            )}
                            <NeedsYouBadge count={needsYou} />
                            {conversation.unread_count > 0 ? (
                                <span className="mj_UnreadBadge" aria-label={`${conversation.unread_count} unread`}>
                                    {conversation.unread_count}
                                </span>
                            ) : overrideUnread ? (
                                <span className="mj_UnreadDot" aria-hidden />
                            ) : null}
                        </span>
                    )}
                </span>
            </button>
            {/* The row menu opens via right-click / long-press for pointer + touch. This
                trigger is invisible to mouse users (no hover reveal) but appears on
                keyboard focus, so keyboard/AT users keep a discoverable, operable route. */}
            <button
                className="mj_ConversationMenu_trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Conversation options"
                ref={(element) => actions.menuTrigger(conversation.id, element)}
                onClick={(event) => actions.menuButton(conversation.id, event)}
            >
                <KebabIcon />
            </button>
        </div>
    );
});

function ConversationListView({
    client,
    state,
    width,
}: {
    client: MatronJournalClient;
    state: ClientState;
    width: number;
}): React.ReactElement {
    const [developerView] = useShowTheWork();
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState<"active" | "favorites" | "archived">("active");
    const [accountOpen, setAccountOpen] = useState(false);
    const [newSessionOpen, setNewSessionOpen] = useState(false);
    // The Coordinator's sheets (chooser, its new chat, Routines), one at a time. Opened from
    // Settings, they take its place and give it back when they close, as the Mac's sit over it.
    // "assigning": the new chat exists and PUT /coordinator is in flight; nothing shows.
    const [coordinatorSheet, setCoordinatorSheet] = useState<{
        kind: "chooser" | "new-chat" | "assigning" | "routines";
        fromSettings: boolean;
        error?: string;
    } | null>(null);
    const coordinatorSheetRef = useRef(coordinatorSheet);
    coordinatorSheetRef.current = coordinatorSheet;
    const [pinDialog, setPinDialog] = useState<PinDialogTarget>();
    const [conversationMenu, setConversationMenu] = useState<{ conversationId: string; left: number; top: number }>();
    const conversationMenuRef = useRef(conversationMenu);
    const conversationMenuElementRef = useRef<HTMLDivElement>(null);
    const conversationMenuOpenerRef = useRef<HTMLElement | null>(null);
    // Pending rAF id for the post-menu-action focus restore; cancelled before re-scheduling
    // and on unmount so a stale callback can never steal focus (see restoreFocusAfterMenuAction).
    const restoreFocusFrameRef = useRef<number | undefined>(undefined);
    const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const longPressTargetRef = useRef<{ conversationId: string; row: HTMLButtonElement } | undefined>(undefined);
    const longPressFiredRef = useRef(false);
    const longPressScrollCleanupRef = useRef<() => void>(() => undefined);
    const openConversationMenuRef = useRef<
        (conversationId: string, left: number, top: number, opener: HTMLElement) => void
    >(() => undefined);
    const longPressControllerRef = useRef<LongPressController | undefined>(undefined);
    const childOutcomesRef = useRef(
        new Map(
            state.conversations
                .filter(isSubChat)
                .map((conversation) => [conversation.id, classifyOutcome(conversation)] as const),
        ),
    );
    const [outcomeAnnouncement, setOutcomeAnnouncement] = useState<string>();
    const [, forceDayTick] = useReducer((n) => n + 1, 0);

    useEffect(() => {
        const nextOutcomes = new Map<string, OutcomeClassification>();
        const changes: string[] = [];
        for (const conversation of state.conversations) {
            if (!isSubChat(conversation)) continue;
            const outcome = classifyOutcome(conversation);
            nextOutcomes.set(conversation.id, outcome);
            const previous = childOutcomesRef.current.get(conversation.id);
            if (previous !== undefined && previous !== outcome) {
                changes.push(`${conversationTitle(conversation)}, ${accessibleOutcome(outcome)}`);
            }
        }
        childOutcomesRef.current = nextOutcomes;
        if (changes.length > 0) setOutcomeAnnouncement(changes.join("; "));
    }, [state.conversations]);

    useEffect(() => {
        const now = new Date();
        const renderedAt = new Date(renderNow);
        if (
            renderedAt.getFullYear() !== now.getFullYear() ||
            renderedAt.getMonth() !== now.getMonth() ||
            renderedAt.getDate() !== now.getDate()
        ) {
            forceDayTick();
        }
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
        const timer = setTimeout(forceDayTick, nextMidnight - now.getTime() + 1000);
        return () => clearTimeout(timer);
    });

    // Message-content search (Apple-parity "Messages" section). The box already filters chat
    // titles in-memory as you type; here we additionally hit the server's FTS endpoint, debounced
    // so keystrokes don't each fire a request. Clearing the box drops the section immediately.
    useEffect(() => {
        if (!query.trim()) {
            void client.searchMessages("");
            return;
        }
        const timer = setTimeout(() => void client.searchMessages(query), MESSAGE_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, client]);

    conversationMenuRef.current = conversationMenu;
    openConversationMenuRef.current = (conversationId, left, top, opener): void => {
        setAccountOpen(false);
        setNewSessionOpen(false);
        conversationMenuOpenerRef.current = opener;
        setConversationMenu({ conversationId, left, top });
    };
    if (!longPressControllerRef.current) {
        longPressControllerRef.current = createLongPressController({
            delayMs: 500,
            onFire: () => {
                const target = longPressTargetRef.current;
                longPressScrollCleanupRef.current();
                if (!target) return;
                const rect = target.row.getBoundingClientRect();
                longPressFiredRef.current = true;
                openConversationMenuRef.current(target.conversationId, rect.right, rect.top, target.row);
            },
        });
    }

    const closeConversationMenu = useCallback((restoreFocus = false): void => {
        if (!conversationMenuRef.current) return;
        setConversationMenu(undefined);
        if (restoreFocus) conversationMenuOpenerRef.current?.focus();
    }, []);

    // ⌘N and ⇧⌘F (shortcuts.ts). Like the Mac, search-all-chats acts only on Conversations,
    // where its field is.
    useShortcutCommand("newSession", () => {
        setAccountOpen(false);
        closeConversationMenu();
        setNewSessionOpen(true);
    });
    useShortcutCommand("searchAllChats", () => {
        if (state.trackerView?.open) return;
        const field = document.getElementById("conversation-search-input") as HTMLInputElement | null;
        field?.focus();
        field?.select();
    });

    // After a menu ACTION (mark-read/archive/unarchive) the focused menuitem unmounts, and
    // archive/unarchive also remove the originating row — so restoring to the opener only works
    // when it survives. Defer past the state-change re-render, then focus the opener if it's still
    // connected (mark-read), else the always-present search input, so keyboard focus never falls
    // through to document.body.
    const restoreFocusAfterMenuAction = useCallback((): void => {
        const opener = conversationMenuOpenerRef.current;
        // Cancel any still-pending restore before scheduling a new one. Without this the
        // leaked callback fires on a LATER tick (or in a later test), finds its opener
        // disconnected, and yanks focus to the search input — a real focus-steal, and the
        // source of the flaky keyboard-focus test.
        if (restoreFocusFrameRef.current != null) cancelAnimationFrame(restoreFocusFrameRef.current);
        restoreFocusFrameRef.current = requestAnimationFrame(() => {
            restoreFocusFrameRef.current = undefined;
            if (opener && opener.isConnected) opener.focus();
            else document.getElementById("conversation-search-input")?.focus();
        });
    }, []);

    const cancelLongPress = useCallback((): void => {
        longPressControllerRef.current?.onPointerCancel();
        longPressTargetRef.current = undefined;
        longPressFiredRef.current = false;
        longPressScrollCleanupRef.current();
    }, []);

    const listenForLongPressScroll = useCallback((): void => {
        longPressScrollCleanupRef.current();
        const onScroll = (): void => cancelLongPress();
        document.addEventListener("scroll", onScroll, true);
        longPressScrollCleanupRef.current = () => {
            document.removeEventListener("scroll", onScroll, true);
            longPressScrollCleanupRef.current = () => undefined;
        };
    }, [cancelLongPress]);

    useEffect(
        () => () => {
            longPressControllerRef.current?.onPointerCancel();
            longPressScrollCleanupRef.current();
            if (restoreFocusFrameRef.current != null) cancelAnimationFrame(restoreFocusFrameRef.current);
        },
        [],
    );

    useEffect(() => {
        if (!conversationMenu) return;
        const onPointerDown = (event: PointerEvent): void => {
            if (!conversationMenuRef.current || conversationMenuElementRef.current?.contains(event.target as Node))
                return;
            closeConversationMenu();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (conversationMenuRef.current && event.key === "Escape") closeConversationMenu(true);
        };
        const onScroll = (): void => {
            if (conversationMenuRef.current) closeConversationMenu();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [Boolean(conversationMenu), closeConversationMenu]);

    useLayoutEffect(() => {
        if (!conversationMenu || !conversationMenuElementRef.current) return;
        const rect = conversationMenuElementRef.current.getBoundingClientRect();
        const left = Math.max(8, Math.min(conversationMenu.left, window.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(conversationMenu.top, window.innerHeight - rect.height - 8));
        if (left !== conversationMenu.left || top !== conversationMenu.top) {
            setConversationMenu({ ...conversationMenu, left, top });
        }
    }, [conversationMenu]);

    useLayoutEffect(() => {
        if (!conversationMenu) return;
        conversationMenuElementRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [conversationMenu]);
    // ONE canonical index feeds BOTH sidebar paths here (top-level fallback + nested
    // splice) AND the client-side selection/unread/mark-all consumers, so "rendered" and
    // "selectable/counted" can never diverge. rendersAsTopLevelRow: a non-child always
    // renders top-level; a child renders top-level only when childSidebarPlacement says so
    // (orphan → always; parent exists → running-only, and then only when it can't nest).
    const sidebarIndex = useMemo(
        () => buildSidebarIndex(state.conversations, state.archivedIds, state.collapsedSubagentParentIds),
        [state.conversations, state.archivedIds, state.collapsedSubagentParentIds],
    );
    const childIndex = useMemo(() => childrenByParent(state.conversations), [state.conversations]);
    // Keyed on the open-items array, which the client replaces whenever an item changes, so the
    // memoised list re-renders (inboxItems is not in CONVERSATION_LIST_IGNORED_STATE) and the
    // counts are rebuilt only then, not on every row render.
    const needsYouCounts = useMemo(() => needsYouByConversation(state.inboxItems), [state.inboxItems]);
    const childRowsOf = (parentId: string): Conversation[] => childIndex.get(parentId) ?? [];
    const isTopLevelRow = (conversation: Conversation): boolean => rendersAsTopLevelRow(conversation, sidebarIndex);
    const conversations = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return state.conversations
            .filter((conversation) => isTopLevelRow(conversation))
            .filter(
                (conversation) =>
                    !normalized ||
                    `${conversation.title} ${conversation.id} ${conversation.snippet}`
                        .toLocaleLowerCase()
                        .includes(normalized),
            );
    }, [query, state.archivedIds, state.conversations]);
    // Journal pins (when this journal has them) replace the browser-local pinned set outright.
    const journalPins = state.journalPins;
    const journalPinnedIds = new Set(journalPins?.map((pin) => pin.convo_id) ?? []);
    const isPinned = (id: string): boolean => (journalPins ? journalPinnedIds.has(id) : state.pinnedIds.has(id));
    const activeAll = conversations.filter((conversation) => !state.archivedIds.has(conversation.id));
    const active = [
        ...activeAll.filter((conversation) => isPinned(conversation.id)),
        ...activeAll.filter((conversation) => !isPinned(conversation.id)),
    ];
    // the Archived tab lists EVERY archived conversation flat — including an archived
    // CHILD of an active parent, which `conversations` drops via isTopLevelRow (so it can be
    // nested under its live parent in Active). Deriving the archived set from the full list
    // (not the filtered `conversations`) keeps that child discoverable + it renders flat,
    // matching how archived parents already render. Search still applies.
    const archived = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return state.conversations
            .filter((conversation) => state.archivedIds.has(conversation.id))
            .filter(
                (conversation) =>
                    !normalized ||
                    `${conversation.title} ${conversation.id} ${conversation.snippet}`
                        .toLocaleLowerCase()
                        .includes(normalized),
            );
    }, [query, state.archivedIds, state.conversations]);
    const visibleRows =
        tab === "favorites"
            ? active.filter((conversation) => state.favoriteIds.has(conversation.id))
            : tab === "archived"
              ? archived
              : active;
    const hasAnyActive = state.conversations.some(
        (conversation) => !state.archivedIds.has(conversation.id) && isTopLevelRow(conversation),
    );
    const hasAnyFavorite = state.conversations.some(
        (conversation) =>
            state.favoriteIds.has(conversation.id) &&
            !state.archivedIds.has(conversation.id) &&
            isTopLevelRow(conversation),
    );
    // Count every archived conversation (parents AND archived children of active parents) so
    // the tab badge matches the flat Archived list they render into.
    const archivedTotal = state.conversations.filter((conversation) => state.archivedIds.has(conversation.id)).length;
    // Visibility is computed from the UNFILTERED conversation set (minus archived), NOT the
    // search-filtered `active` — mark-all operates on the full active partition regardless of
    // the search box, so the button must not vanish just because the search hides the unread rows.
    const hasActiveUnread = state.conversations.some(
        (conversation) =>
            effectiveUnread(conversation, state.unreadOverrideIds) &&
            !state.archivedIds.has(conversation.id) &&
            isTopLevelRow(conversation),
    );
    const menuConversation = conversationMenu
        ? state.conversations.find((conversation) => conversation.id === conversationMenu.conversationId)
        : undefined;

    useEffect(() => {
        if (conversationMenu && !menuConversation) closeConversationMenu();
    }, [conversationMenu, menuConversation, closeConversationMenu]);

    const openAtElement = useCallback(
        (conversationId: string, anchor: HTMLElement, opener: HTMLElement = anchor): void => {
            const rect = anchor.getBoundingClientRect();
            openConversationMenuRef.current(conversationId, rect.right, rect.bottom, opener);
        },
        [],
    );
    // Built once: every handler reads refs or stable callbacks, so the memoised rows never see a
    // new actions object.
    const rowActions = useMemo<ConversationRowActions>(
        () => ({
            open(conversationId, event) {
                if (longPressFiredRef.current) {
                    longPressFiredRef.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                void client.selectConversation(conversationId);
            },
            contextMenu(conversationId, event) {
                event.preventDefault();
                const keyboardTriggered = event.clientX === 0 && event.clientY === 0;
                if (keyboardTriggered) {
                    const trigger = menuTriggerRefs.current.get(conversationId);
                    openAtElement(conversationId, trigger ?? event.currentTarget, event.currentTarget);
                    return;
                }
                openConversationMenuRef.current(conversationId, event.clientX, event.clientY, event.currentTarget);
            },
            pointerDown(conversationId, event) {
                if (event.pointerType !== "touch") return;
                longPressTargetRef.current = { conversationId, row: event.currentTarget };
                longPressFiredRef.current = false;
                longPressControllerRef.current?.onPointerDown(event.clientX, event.clientY);
                listenForLongPressScroll();
            },
            pointerMove(event) {
                if (event.pointerType !== "touch") return;
                longPressControllerRef.current?.onPointerMove(event.clientX, event.clientY);
                if (!longPressControllerRef.current?.isPending && !longPressControllerRef.current?.didFire) {
                    longPressScrollCleanupRef.current();
                }
            },
            pointerUp(event) {
                if (event.pointerType !== "touch") return;
                longPressControllerRef.current?.onPointerUp();
                longPressTargetRef.current = undefined;
                longPressScrollCleanupRef.current();
            },
            pointerCancel(event) {
                if (event.pointerType === "touch") cancelLongPress();
            },
            menuTrigger(conversationId, element) {
                if (element) menuTriggerRefs.current.set(conversationId, element);
                else menuTriggerRefs.current.delete(conversationId);
            },
            menuButton(conversationId, event) {
                event.stopPropagation();
                openAtElement(conversationId, event.currentTarget);
            },
        }),
        [client, openAtElement, listenForLongPressScroll, cancelLongPress],
    );

    // Nav rail: which section is current, and the unread total it badges (archived rows excluded;
    // a row marked unread by hand counts once, like its own badge dot).
    const navActive: NavKey = state.trackerView?.open
        ? NAV_KEY_FOR_VIEW[state.trackerView.view ?? "inbox"]
        : state.opsView?.open
          ? "ops"
          : state.filesView?.open && !isElectronRuntime()
            ? "files"
            : "conversations";
    const unreadTotal = countUnread(state.conversations, state.archivedIds, state.unreadOverrideIds);
    // The For you badge: open items awaiting the user, the inbox's own "Needs you" filter.
    const needsYouTotal = (state.inboxItems ?? []).filter(needsUser).length;
    // The Projects badge: what needs the user across the missions (the Mac's Missions total).
    const projectsNeedsYouTotal = projectsNeedsYou(state.inboxItems, state.missions);
    const closeSettings = useCallback(() => setAccountOpen(false), []);
    const closeCoordinatorSheet = (): void => {
        if (coordinatorSheet?.fromSettings) setAccountOpen(true);
        setCoordinatorSheet(null);
    };
    const coordinatorConversation = state.coordinatorConvoId
        ? state.conversations.find((conversation) => conversation.id === state.coordinatorConvoId)
        : undefined;
    const renderNow = Date.now();
    const pinnedRows = journalPins ? [] : visibleRows.filter((conversation) => state.pinnedIds.has(conversation.id));
    const unpinnedRows = journalPins
        ? visibleRows.filter((conversation) => tab !== "active" || !journalPinnedIds.has(conversation.id))
        : visibleRows.filter((conversation) => !state.pinnedIds.has(conversation.id));
    const rowGroups = [
        ...(pinnedRows.length ? [{ label: "Pinned", rows: pinnedRows }] : []),
        ...groupByDay(unpinnedRows, renderNow),
    ];
    // The journal's Pinned section (Active tab only), in the journal's position order. Each pin
    // keeps its conversation (absent when the journal flags it missing or this tab hasn't seen
    // it); the search box matches the pin label as well as the conversation's title. An archived
    // pin moves to the Archived tab with its conversation, as a browser-local pin always did —
    // unless it is missing (no row there to manage it from) or offers a successor (the prompt to
    // move the pin off the archived chat).
    const shownPins = (journalPins ?? []).filter(
        (pin) => pin.missing || pin.successor || !state.archivedIds.has(pin.convo_id),
    );
    const pinSection =
        journalPins && tab === "active"
            ? shownPins
                  .map((pin) => ({
                      pin,
                      conversation: pin.missing
                          ? undefined
                          : state.conversations.find((conversation) => conversation.id === pin.convo_id),
                  }))
                  .filter(({ pin, conversation }) => {
                      const normalized = query.trim().toLocaleLowerCase();
                      if (!normalized) return true;
                      return `${pin.label} ${conversation ? `${conversation.title} ${conversation.snippet}` : ""}`
                          .toLocaleLowerCase()
                          .includes(normalized);
                  })
            : [];
    // Move up / Move down step through the pins the Pinned section shows (hidden archived pins
    // keep their place but are hopped over, so every step moves the row on screen).
    const menuPinIndex = conversationMenu
        ? shownPins.findIndex((pin) => pin.convo_id === conversationMenu.conversationId)
        : -1;
    const shownPinIds = shownPins.map((pin) => pin.convo_id);
    const nestedChildRows = (conversation: Conversation): React.ReactElement[] =>
        tab === "archived"
            ? []
            : childRowsOf(conversation.id)
                  .filter(
                      (child) =>
                          !state.archivedIds.has(child.id) &&
                          // A pinned sub-chat is drawn once, in the Pinned section.
                          !journalPinnedIds.has(child.id) &&
                          childSidebarPlacement(child, sidebarIndex) === "nested",
                  )
                  .map((child, index, list) => renderConversation(child, true, index === list.length - 1));
    const renderConversation = (
        conversation: ClientState["conversations"][number],
        isSubagent = false,
        isLastSubagent = false,
        // A journal pin row: the pin's glyph + label lead, the conversation's title goes secondary.
        pin?: ConvoPin,
    ): React.ReactElement => {
        const selected = state.selectedConversationId === conversation.id;
        const overrideUnread = state.unreadOverrideIds.has(conversation.id) && conversation.unread_count === 0;
        // Developer view off: the preview never shows a command line or markdown source — a tool
        // call reads as its activity ("Reading paths.py…"), anything else as one line of prose.
        // Developer view on keeps the snippet's words, with only the markdown dropped.
        const preview = developerView
            ? snippetText(conversation.snippet)
            : previewLine({ ...conversation, worker: workerKind(conversation) });
        // Items this conversation raised that wait on the user, and the "New" marker on a session
        // that arrived unasked and has not been opened (a room's title, or a child's parent link,
        // can land after the mark).
        const needsYou = needsYouCounts.get(conversation.id) ?? 0;
        const isNew =
            !selected &&
            !isSubagent &&
            !isSubChat(conversation) &&
            state.newConversationIds.has(conversation.id) &&
            !isAgentRoomTitle(conversation.title);
        // When this parent's subagent rows are collapsed, surface a subtle count of the hidden
        // child rows so the collapse stays discoverable on the row itself. Gate on the CANONICAL
        // index (hasSubagentChildRows) — NOT an independent running-child count — so it agrees with
        // the menu and the placement derivation. An archived parent hosts no child rows (its running
        // children are promoted to top-level), so it is absent from that set → no count, no false
        // "N hidden" even if its collapse state persisted through archival. The set is only populated
        // for real hosts, so the running-child count below always measures exactly what collapse hides.
        const collapsedSubagentChildren =
            !isSubagent &&
            state.collapsedSubagentParentIds.has(conversation.id) &&
            hasSubagentChildRows(conversation, sidebarIndex)
                ? childRowsOf(conversation.id).filter(
                      (child) =>
                          !state.archivedIds.has(child.id) &&
                          // A pinned sub-chat stays in the Pinned section; collapse never hides it.
                          !journalPinnedIds.has(child.id) &&
                          child.session_state === "running",
                  )
                : [];
        const collapsedSubagentCount = collapsedSubagentChildren.length;
        // Collapse removes each hidden child's own inline row + unread badge. If any hidden child
        // is still unread, the chip must carry that signal — otherwise a streaming child's unread
        // surfaces nowhere (the aggregate badge already excludes nested children, and the strip
        // pills never show unread). Measured over the SAME set the count derives from.
        const collapsedSubagentUnread = collapsedSubagentChildren.some((child) =>
            effectiveUnread(child, state.unreadOverrideIds),
        );
        return (
            <ConversationRow
                key={conversation.id}
                conversation={conversation}
                isSubagent={isSubagent}
                pin={pin}
                selected={selected}
                unread={effectiveUnread(conversation, state.unreadOverrideIds)}
                overrideUnread={overrideUnread}
                pinned={isPinned(conversation.id)}
                favorite={state.favoriteIds.has(conversation.id)}
                menuOpen={conversationMenu?.conversationId === conversation.id}
                needsYou={needsYou}
                isNew={isNew}
                timestamp={relativeDayLabel(conversation.last_ts ?? conversation.created_at, renderNow)}
                collapsedCount={collapsedSubagentCount}
                collapsedUnread={collapsedSubagentUnread}
                isLastSubagent={isLastSubagent}
                preview={preview}
                agents={state.agents}
                actions={rowActions}
            />
        );
    };

    // A pin whose conversation is gone (or not in this client's list): greyed, Move pin… / Unpin only.
    const renderMissingPin = (pin: ConvoPin): React.ReactElement => (
        <div className="mj_ConversationListItem_wrapper mj_PinRow_missing" role="listitem" key={pin.convo_id}>
            <div className="mj_ConversationListItem" aria-label={`Pinned ${pin.label}, conversation unavailable`}>
                <span className="mj_ConversationListPinGlyph mj_PinGlyph" aria-hidden="true">
                    {pinGlyph(pin)}
                </span>
                <span className="mj_ConversationListText">
                    <span className="mj_ConversationListName">{pin.label}</span>
                    <span className="mj_ConversationListMeta">Conversation unavailable</span>
                </span>
            </div>
            <div className="mj_PinRow_actions">
                <button type="button" onClick={() => setPinDialog({ kind: "move", convoId: pin.convo_id })}>
                    Move pin…
                </button>
                <button type="button" onClick={() => void client.removePin(pin.convo_id)}>
                    Unpin
                </button>
            </div>
        </div>
    );
    // "New session on <box> — move pin here?" under a pin the journal has a successor for.
    const renderSuccessorHint = (pin: ConvoPin): React.ReactElement | null =>
        pin.successor ? (
            <div className="mj_PinSuccessor" role="listitem" key={`${pin.convo_id}:successor`}>
                <span className="mj_PinSuccessor_text">
                    {successorHintText(pin, state.conversations, state.agents)}
                </span>
                <span className="mj_PinRow_actions">
                    <button type="button" onClick={() => void client.acceptPinSuccessor(pin)}>
                        Move
                    </button>
                    <button type="button" onClick={() => void client.dismissPinSuccessor(pin)}>
                        Dismiss
                    </button>
                </span>
            </div>
        ) : null;

    return (
        <div
            className={`mj_Sidebar_outerWrapper ${mainSurfaceOpen(state, !isElectronRuntime()) ? "mj_Sidebar_mobileHidden" : ""}`}
            style={{ "--mj-left-panel-width": `${width}px` } as React.CSSProperties}
        >
            <NavRail
                active={navActive}
                filesAvailable={!isElectronRuntime()}
                counts={{ projects: projectsNeedsYouTotal, conversations: unreadTotal, decisions: needsYouTotal }}
                onSelect={(key) => {
                    setAccountOpen(false);
                    closeConversationMenu();
                    if (key === "conversations") {
                        client.closeTrackerView();
                        client.closeOpsView();
                        client.closeFilesView();
                    } else if (key === "ops") {
                        if (!state.opsView?.open) client.openOpsView();
                    } else if (key === "files") {
                        if (!state.filesView?.open) client.openFilesView();
                    }
                    // A rail tap always lands on the section's home, not a page left open inside it.
                    else
                        client.openTrackerView({
                            view: NAV_VIEW[key],
                            projectId: null,
                            missionId: null,
                            itemId: null,
                            memoryName: null,
                        });
                }}
                coordinator={{
                    selected:
                        !state.trackerView?.open &&
                        !!state.coordinatorConvoId &&
                        state.selectedConversationId === state.coordinatorConvoId,
                    unread: coordinatorConversation?.unread_count ?? 0,
                    onOpen: () => {
                        setAccountOpen(false);
                        closeConversationMenu();
                        void client.openCoordinator().then((opened) => {
                            // A new coordinator chat being assigned is the answer on its way: its own
                            // result (Settings back, or the chooser with the error) lands instead.
                            if (opened || coordinatorSheetRef.current?.kind === "assigning") return;
                            setCoordinatorSheet({ kind: "chooser", fromSettings: false });
                        });
                    },
                }}
                footer={
                    // Mac: theme and account live in the Settings sheet; the rail foot keeps one
                    // Settings button carrying the connection dot.
                    <button
                        className="mj_IconButton mj_NavRail_settings"
                        type="button"
                        aria-label={`Settings, ${
                            state.connection === "online"
                                ? "connected"
                                : state.connection === "connecting"
                                  ? "connecting"
                                  : "offline"
                        }`}
                        title={`Settings · ${
                            state.connection === "online"
                                ? "connected"
                                : state.connection === "connecting"
                                  ? "connecting…"
                                  : "offline"
                        }`}
                        onClick={() => {
                            setNewSessionOpen(false);
                            setAccountOpen((open) => !open);
                        }}
                    >
                        <SettingsIcon />
                        <span
                            className={`mj_NavRail_status mj_NavRail_status_${state.connection}`}
                            aria-hidden="true"
                        />
                    </button>
                }
            />
            <nav className="mj_ConversationListPanel" aria-label="Room list">
                <header
                    className="mj_ConversationListHeader"
                    aria-label="Room options"
                    data-testid="conversation-list-header"
                >
                    <h2 className="mj_ConversationListTitle">Conversations</h2>
                    <div className="mj_ConversationListHeaderActions">
                        {tab !== "archived" && hasActiveUnread && (
                            <button
                                className="mj_IconButton mj_MarkAllReadButton"
                                type="button"
                                aria-label="Mark all as read"
                                onClick={() => client.markAllRead()}
                            >
                                <MarkAllReadIcon />
                            </button>
                        )}
                        <button
                            className="mj_IconButton"
                            type="button"
                            aria-label="Go to number"
                            title={`Go to number (${goToNumberShortcutLabel()})`}
                            onClick={() => client.openGoToNumber()}
                        >
                            <NumberSignIcon />
                        </button>
                        {/* Mac: New Chat is the toolbar's square.and.pencil glyph, not a button row. */}
                        <button
                            className="mj_IconButton mj_HeaderNavButton mj_IconButton_badged"
                            type="button"
                            aria-label="New session"
                            title={`New session (${shortcutLabel("n")}) — runs /start`}
                            onClick={() => {
                                setAccountOpen(false);
                                closeConversationMenu();
                                setNewSessionOpen(true);
                            }}
                        >
                            <ComposeIcon />
                        </button>
                    </div>
                </header>
                <div className="mj_ConversationListTabs" role="group" aria-label="Filter conversations">
                    {(
                        [
                            ["active", "Active"],
                            ["favorites", "Favorites"],
                            ["archived", "Archived"],
                        ] as const
                    ).map(([key, label]) => (
                        <button
                            key={key}
                            type="button"
                            data-tab={key}
                            className={`mj_Seg_item mj_ConversationListTab${tab === key ? " mj_Seg_item_on mj_ConversationListTab_active" : ""}`}
                            aria-pressed={tab === key}
                            aria-label={key === "favorites" ? "Favorites" : undefined}
                            onClick={(event) => {
                                setTab(key);
                                event.currentTarget.focus({ preventScroll: true });
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <div data-testid="conversation-search" className="mj_ConversationSearch" role="search">
                    <SearchField
                        id="conversation-search-input"
                        className="mj_SearchField_subtle mj_ConversationSearch_field"
                        value={query}
                        onChange={setQuery}
                        placeholder="Search"
                        label="Search"
                        // Server rejects message-search queries over 256 chars; cap the shared
                        // box so a giant paste can't produce a misleading "unavailable" state.
                        maxLength={256}
                    />
                </div>
                {state.preferencesUnavailable && (
                    <div className="mj_ConnectionError" role="status">
                        {PREFERENCES_UNAVAILABLE_ERROR}
                    </div>
                )}
                {state.controlError && (
                    <div className="mj_ConnectionError" role="status">
                        {state.controlError}
                    </div>
                )}
                {outcomeAnnouncement && (
                    <span
                        className="mj_ScreenReaderOnly mj_SubagentOutcomeStatus"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                    >
                        {outcomeAnnouncement}
                    </span>
                )}
                <div className="mj_ConversationList" data-testid="conversation-list">
                    <NumberSearchResult client={client} query={query} />
                    {/* Active/Favorites render each parent row, then splice
                                        its NON-ARCHIVED subagent children in beneath (indented) —
                                        archiving a child removes it from these tabs. The Archived
                                        tab renders flat (archived parents + archived children as
                                        top-level rows), so an archived child stays discoverable +
                                        unarchivable regardless of its parent's state.
                                        children are TRANSIENT — a child nests here ONLY
                                        while running (subagents are one-shot; a done/idle child
                                        drops out of the sidebar but stays in state.conversations so
                                        the header pill strip still shows it when its parent is
                                        selected). The gate is childSidebarPlacement — the SAME
                                        predicate that builds the top-level list above — so the
                                        nested path and the fallback path stay in lock-step (a done
                                        child of an ARCHIVED parent can't leak in via either). The
                                        Archived tab is unaffected. */}
                    {/* Mac sidebar: rows sit under day section headers ("Today",
                                        "Yesterday", weekday, date); pinned rows keep their own
                                        section first. Each parent row is followed by its nested
                                        running children, as before. */}
                    {pinSection.length > 0 && (
                        <section className="mj_ConversationListGroup" aria-label="Pinned">
                            <div className="mj_ConversationListGroup_label" aria-hidden="true">
                                Pinned
                            </div>
                            <div role="list">
                                {pinSection.flatMap(({ pin, conversation }) =>
                                    conversation
                                        ? [
                                              renderConversation(conversation, false, false, pin),
                                              renderSuccessorHint(pin),
                                              ...nestedChildRows(conversation),
                                          ].filter((row): row is React.ReactElement => row !== null)
                                        : [renderMissingPin(pin), renderSuccessorHint(pin)].filter(
                                              (row): row is React.ReactElement => row !== null,
                                          ),
                                )}
                            </div>
                        </section>
                    )}
                    {rowGroups.map((group) => (
                        <section className="mj_ConversationListGroup" key={group.label} aria-label={group.label}>
                            <div className="mj_ConversationListGroup_label" aria-hidden="true">
                                {group.label}
                            </div>
                            <div role="list">
                                {group.rows.flatMap((conversation) => [
                                    renderConversation(conversation, false),
                                    ...nestedChildRows(conversation),
                                ])}
                            </div>
                        </section>
                    ))}
                    {tab === "active" && !hasAnyActive && archivedTotal === 0 && !pinSection.length && (
                        <p className="mj_ConversationListEmpty">Your agent conversations will appear here.</p>
                    )}
                    {tab === "active" && !hasAnyActive && archivedTotal > 0 && !pinSection.length && (
                        <p className="mj_ConversationListEmpty">No active conversations.</p>
                    )}
                    {tab === "active" && hasAnyActive && !visibleRows.length && !pinSection.length && (
                        <p className="mj_ConversationListEmpty">No conversations match your search.</p>
                    )}
                    {tab === "favorites" && !hasAnyFavorite && (
                        <p className="mj_ConversationListEmpty">No favorite conversations yet.</p>
                    )}
                    {tab === "favorites" && hasAnyFavorite && !visibleRows.length && (
                        <p className="mj_ConversationListEmpty">No favorites match your search.</p>
                    )}
                    {tab === "archived" && archivedTotal === 0 && (
                        <p className="mj_ConversationListEmpty">No archived conversations.</p>
                    )}
                    {tab === "archived" && archivedTotal > 0 && !visibleRows.length && (
                        <p className="mj_ConversationListEmpty">No archived conversations match your search.</p>
                    )}
                    {/* Inside the conversation list scroll container so the Messages section
                                        scrolls with the chat list — a long hit list stays reachable. */}
                    <MessageSearchResults
                        query={query}
                        search={state.messageSearch}
                        now={renderNow}
                        onSelect={(hit) => client.openSearchHit(hit)}
                    />
                </div>
            </nav>
            {accountOpen && (
                <SettingsSheet
                    client={client}
                    session={state.session}
                    connection={state.connection}
                    notices={state.userSettingsUnsupported ? undefined : state.userSettings?.notices}
                    noticesError={state.userSettingsError}
                    autoApproveCoordinatorSpawns={
                        state.userSettingsUnsupported ? undefined : state.userSettings?.auto_approve_coordinator_spawns
                    }
                    onAutoApproveCoordinatorSpawnsChange={(value) =>
                        void client.setAutoApproveCoordinatorSpawnsSetting(value)
                    }
                    onLoadSettings={() => void client.loadSettings()}
                    onNoticesChange={(value) => void client.setNoticesSetting(value)}
                    onChooseCoordinator={() => {
                        setAccountOpen(false);
                        setCoordinatorSheet({ kind: "chooser", fromSettings: true });
                    }}
                    onOpenRoutines={() => {
                        setAccountOpen(false);
                        setCoordinatorSheet({ kind: "routines", fromSettings: true });
                    }}
                    onSignOut={() => {
                        setAccountOpen(false);
                        void client.logout();
                    }}
                    onClose={closeSettings}
                />
            )}
            {newSessionOpen && <OneTapNewSessionSheet client={client} onClose={() => setNewSessionOpen(false)} />}
            {coordinatorSheet?.kind === "chooser" && (
                <CoordinatorChooserSheet
                    client={client}
                    state={state}
                    initialError={coordinatorSheet.error}
                    onClose={closeCoordinatorSheet}
                    onNewChat={() => setCoordinatorSheet({ ...coordinatorSheet, kind: "new-chat", error: undefined })}
                />
            )}
            {coordinatorSheet?.kind === "new-chat" && (
                <NewSessionSheet
                    client={client}
                    title="New coordinator chat"
                    initialModel={COORDINATOR_NEW_CHAT_MODEL}
                    // Closing the new chat goes back to the chooser. A created chat closes it too,
                    // and onCreated runs in the same batch: it replaces the chooser with
                    // "assigning", so the chooser never shows while the new chat becomes the
                    // Coordinator. The answer lands only if nothing else opened meanwhile.
                    onClose={() => setCoordinatorSheet({ ...coordinatorSheet, kind: "chooser", error: undefined })}
                    onCreated={(convoId) => {
                        const fromSettings = coordinatorSheet.fromSettings;
                        const assigning = { kind: "assigning" as const, fromSettings };
                        setCoordinatorSheet(assigning);
                        void client.setCoordinator(convoId).then((error) => {
                            if (coordinatorSheetRef.current !== assigning) return;
                            if (error) {
                                // The chat started but did not become the Coordinator: say so in the chooser.
                                setCoordinatorSheet({ kind: "chooser", fromSettings, error });
                                return;
                            }
                            setCoordinatorSheet(null);
                            if (fromSettings) setAccountOpen(true);
                        });
                    }}
                />
            )}
            {coordinatorSheet?.kind === "routines" && <RoutinesSheet client={client} onClose={closeCoordinatorSheet} />}
            {pinDialog && (
                <PinDialog client={client} state={state} target={pinDialog} onClose={() => setPinDialog(undefined)} />
            )}
            {conversationMenu && menuConversation && (
                <div
                    className="mj_HeaderMenu mj_ConversationMenu"
                    role="menu"
                    ref={conversationMenuElementRef}
                    style={{ position: "fixed", left: conversationMenu.left, top: conversationMenu.top }}
                    onKeyDown={(event) => {
                        const items = Array.from(
                            event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
                        );
                        const currentIndex = items.findIndex((item) => item === document.activeElement);
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            const direction = event.key === "ArrowDown" ? 1 : -1;
                            const nextIndex =
                                currentIndex === -1
                                    ? event.key === "ArrowDown"
                                        ? 0
                                        : items.length - 1
                                    : (currentIndex + direction + items.length) % items.length;
                            items[nextIndex]?.focus();
                        } else if (event.key === "Enter" || event.key === " ") {
                            const currentItem = items[currentIndex];
                            if (!currentItem) return;
                            event.preventDefault();
                            currentItem.click();
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            closeConversationMenu(true);
                        }
                    }}
                >
                    {journalPins ? (
                        !(conversationMenu && journalPinnedIds.has(conversationMenu.conversationId)) ? (
                            <button
                                className="mj_ConversationMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeConversationMenu();
                                    setPinDialog({ kind: "edit", convoId: menuConversation.id });
                                }}
                            >
                                <PinIcon aria-hidden />
                                Pin to sidebar…
                            </button>
                        ) : (
                            <>
                                <button
                                    className="mj_ConversationMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closeConversationMenu();
                                        setPinDialog({ kind: "edit", convoId: menuConversation.id });
                                    }}
                                >
                                    <FileEditIcon aria-hidden />
                                    Edit pin…
                                </button>
                                {menuPinIndex > 0 && (
                                    <button
                                        className="mj_ConversationMenu_item"
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            closeConversationMenu();
                                            void client.shiftPin(menuConversation.id, "up", shownPinIds);
                                            restoreFocusAfterMenuAction();
                                        }}
                                    >
                                        <ChevronUpIcon aria-hidden />
                                        Move up
                                    </button>
                                )}
                                {menuPinIndex >= 0 && menuPinIndex < shownPins.length - 1 && (
                                    <button
                                        className="mj_ConversationMenu_item"
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            closeConversationMenu();
                                            void client.shiftPin(menuConversation.id, "down", shownPinIds);
                                            restoreFocusAfterMenuAction();
                                        }}
                                    >
                                        <ChevronDownIcon aria-hidden />
                                        Move down
                                    </button>
                                )}
                                <button
                                    className="mj_ConversationMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closeConversationMenu();
                                        setPinDialog({ kind: "move", convoId: menuConversation.id });
                                    }}
                                >
                                    <PinIcon aria-hidden />
                                    Move pin…
                                </button>
                                <button
                                    className="mj_ConversationMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closeConversationMenu();
                                        void client.removePin(menuConversation.id);
                                        restoreFocusAfterMenuAction();
                                    }}
                                >
                                    <PinIcon aria-hidden />
                                    Unpin
                                </button>
                            </>
                        )
                    ) : state.pinnedIds.has(menuConversation.id) ? (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.unpinConversation(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <PinIcon aria-hidden />
                            Unpin
                        </button>
                    ) : (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.pinConversation(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <PinIcon aria-hidden />
                            Pin
                        </button>
                    )}
                    {state.favoriteIds.has(menuConversation.id) ? (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.unfavoriteConversation(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <StarFilledIcon aria-hidden />
                            Remove from Favorites
                        </button>
                    ) : (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.favoriteConversation(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <StarIcon aria-hidden />
                            Add to Favorites
                        </button>
                    )}
                    {!state.archivedIds.has(menuConversation.id) &&
                        !effectiveUnread(menuConversation, state.unreadOverrideIds) && (
                            <button
                                className="mj_ConversationMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeConversationMenu();
                                    client.markConversationUnread(menuConversation.id);
                                    restoreFocusAfterMenuAction();
                                }}
                            >
                                <MarkUnreadIcon aria-hidden />
                                Mark as unread
                            </button>
                        )}
                    {!state.archivedIds.has(menuConversation.id) &&
                        effectiveUnread(menuConversation, state.unreadOverrideIds) && (
                            <button
                                className="mj_ConversationMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeConversationMenu();
                                    client.markConversationRead(menuConversation.id);
                                    restoreFocusAfterMenuAction();
                                }}
                            >
                                <MarkReadIcon aria-hidden />
                                Mark as read
                            </button>
                        )}
                    {/* Manual collapse/expand of this conversation's subagent child rows —
                            shown ONLY when it currently hosts child rows (hasSubagentChildRows
                            stays true while collapsed, so "Show subagents" remains reachable). */}
                    {hasSubagentChildRows(menuConversation, sidebarIndex) && (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.toggleSubagentCollapse(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <ChevronDownIcon aria-hidden />
                            {state.collapsedSubagentParentIds.has(menuConversation.id)
                                ? "Show subagents"
                                : "Collapse subagents"}
                        </button>
                    )}
                    {state.archivedIds.has(menuConversation.id) ? (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.unarchiveConversation(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <UnarchiveIcon aria-hidden />
                            Unarchive
                        </button>
                    ) : (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closeConversationMenu();
                                client.archiveConversation(menuConversation.id);
                                restoreFocusAfterMenuAction();
                            }}
                        >
                            <ArchiveIcon aria-hidden />
                            Archive
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Click-to-toggle for a popover trigger that also works for touch. On iOS a tap on the trigger of
 * an open popover first moves focus out of the panel (the blur handler closes it) and only then
 * clicks, so a plain `setOpen(!open)` read "closed" and reopened it. The open state is captured at
 * press time instead and the click toggles from that. Keyboard activation has no press, so it
 * toggles from the current state.
 */
export function usePressToggle(
    open: boolean,
    setOpen: (next: boolean) => void,
): {
    onPointerDown: () => void;
    onKeyDown: () => void;
    onClick: () => void;
} {
    const openAtPress = useRef<boolean | null>(null);
    return {
        onPointerDown: () => {
            openAtPress.current = open;
        },
        onKeyDown: () => {
            openAtPress.current = null;
        },
        onClick: () => {
            const wasOpen = openAtPress.current ?? open;
            openAtPress.current = null;
            setOpen(!wasOpen);
        },
    };
}

// State the conversation list never reads. The open conversation's streams, activity, header
// and events change many times a second while an agent works; re-rendering every sidebar row for
// each of those frames kept the main thread busy with nothing on the list changing.
const CONVERSATION_LIST_IGNORED_STATE = new Set<keyof ClientState>([
    "textStreams",
    "toolStreams",
    "activity",
    "sessionStatus",
    "events",
    "pendingMessages",
    "loadingHistory",
    "hasOlderHistory",
    "sendTick",
    "dragActive",
    "subChatPane",
    // The Routines sheet reads its own state from the client; the list never does.
    "routines",
    "composerAttachments",
    "chatTasks",
    "focusTarget",
    "chatSearch",
]);

export function sameStateExcept(
    previous: ClientState,
    next: ClientState,
    ignored: ReadonlySet<keyof ClientState>,
): boolean {
    if (previous === next) return true;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as (keyof ClientState)[]);
    for (const key of keys) {
        if (!ignored.has(key) && previous[key] !== next[key]) return false;
    }
    return true;
}

const ConversationList = React.memo(
    ConversationListView,
    (previous, next) =>
        previous.client === next.client &&
        previous.width === next.width &&
        sameStateExcept(previous.state, next.state, CONVERSATION_LIST_IGNORED_STATE),
);

// Redesign-v4 pane-width bands (ResizeObserver on the chat pane, not viewport):
// >=720 full 2×2 usage grid (keep all four bars as long as they genuinely fit — the
// 2×2 is ~430px with reset times and clears a minimal title down to ~720); <720 collapse to a ctx+5h
// two-row stack + popover with all four. >=560 full subtitle + Compact; <560 subtitle →
// status dot + short model, title popover, Compact hidden.
// Both widths include the reset time trailing each limit's bar ("3h20", "Sun 10pm").
const USAGE_COLLAPSE_PX = 720;
// with host cpu/ram the grid grows to a 3rd column (~600px with reset times) — it needs a wider pane
// to render without crushing the title, so collapse earlier (to the ctx+5h popover, which
// still lists all six bars). Only the collapse WIDTH moves for the wide grid; the collapse
// BEHAVIOUR (ctx+5h stack + popover) is unchanged, preserving the tuned narrow experience.
const USAGE_COLLAPSE_WIDE_PX = 960;
const USAGE_WIDE_METER_COUNT = 4; // >4 meters ⇒ 3rd column ⇒ use the wide threshold
const TITLE_COLLAPSE_PX = 560;

export interface HeaderCollapse {
    usageCollapsed: boolean;
    titleCollapsed: boolean;
    /** Rooms · n and the bell live in the ⋯ menu and Compact keeps only its icon. */
    controlsFolded: boolean;
}

const EXPANDED_HEADER: HeaderCollapse = { usageCollapsed: false, titleCollapsed: false, controlsFolded: false };

export function useAdaptiveHeader(bodyEl: HTMLElement | null, meterCount = 0): HeaderCollapse {
    const usageCollapsePx = meterCount > USAGE_WIDE_METER_COUNT ? USAGE_COLLAPSE_WIDE_PX : USAGE_COLLAPSE_PX;
    const foldPx = meterCount > USAGE_WIDE_METER_COUNT ? CONTROLS_FOLD_WIDE_PX : CONTROLS_FOLD_PX;
    const [collapse, setCollapse] = useState<HeaderCollapse>(EXPANDED_HEADER);
    const collapseRef = useRef(collapse);

    useEffect(() => {
        if (bodyEl == null || typeof ResizeObserver === "undefined") {
            const current = collapseRef.current;
            if (current.usageCollapsed || current.titleCollapsed || current.controlsFolded) {
                collapseRef.current = EXPANDED_HEADER;
                setCollapse(EXPANDED_HEADER);
            }
            return;
        }

        let latestWidth = 0;
        let frame: number | null = null;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            latestWidth = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
            // v6: the same observer drives the chat-pane breakpoints (data-pane).
            applyPaneBand(bodyEl, latestWidth);
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                const usageCollapsed = latestWidth < usageCollapsePx;
                const titleCollapsed = latestWidth < TITLE_COLLAPSE_PX;
                // Folded below the width the current usage form needs: the collapsed two-bar
                // disclosure is far narrower than either grid.
                const controlsFolded = latestWidth < (usageCollapsed ? CONTROLS_FOLD_USAGE_COLLAPSED_PX : foldPx);
                if (
                    collapseRef.current.usageCollapsed !== usageCollapsed ||
                    collapseRef.current.titleCollapsed !== titleCollapsed ||
                    collapseRef.current.controlsFolded !== controlsFolded
                ) {
                    const next = { usageCollapsed, titleCollapsed, controlsFolded };
                    collapseRef.current = next;
                    setCollapse(next);
                }
            });
        });
        observer.observe(bodyEl);

        return () => {
            observer.disconnect();
            if (frame != null) cancelAnimationFrame(frame);
        };
    }, [bodyEl, usageCollapsePx, foldPx]);

    return collapse;
}

// Below these pane widths the controls beside the title fold: Rooms · n and the bell move into
// the ⋯ menu and Compact keeps only its icon, so the title keeps about 240px. Measured with every
// control showing (usage grid with reset times, Compact, Rooms · n, Tasks, Media, the bell, ⋯).
// The full four-meter grid shows from USAGE_COLLAPSE_PX and needs about 810px of controls
// inline; the six-meter grid shows from USAGE_COLLAPSE_WIDE_PX and needs about 160px more; the
// collapsed two-bar disclosure needs about 590px. So a six-meter header can be inline just below
// USAGE_COLLAPSE_WIDE_PX and fold again just above it, where the wide grid appears. The Mac
// shrinks its mission chip instead and never folds, but its title row has no usage grid.
const CONTROLS_FOLD_PX = 1060;
const CONTROLS_FOLD_WIDE_PX = 1200;
const CONTROLS_FOLD_USAGE_COLLAPSED_PX = 840;

function useMinuteClock(now?: number): number {
    const [clockNow, setClockNow] = useState(Date.now);
    useEffect(() => {
        if (now !== undefined) return;
        const interval = window.setInterval(() => setClockNow(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, [now]);
    return now ?? clockNow;
}

// Pick the newest of several readings for the same meter. An unstamped candidate (a legacy
// limits[] entry from a bridge that predates `sampled_at_ms`) has no freshness to compare, so it
// ranks below any stamped one but still wins when it is all we have. Ties go to the later
// candidate, which keeps the callers' source order as the tiebreak: legacy < status.vitals < the
// live push, i.e. the fastest-cadence source wins a same-millisecond stamp.
// Upper bound on a believable epoch-millisecond sample stamp. A garbled or wrongly-scaled wire
// value (1e308, say) is finite, so it would otherwise win every freshness comparison forever
// AND clamp to age zero, pinning the meter to a bogus reading no later sample could displace.
//
// Deliberately an ABSOLUTE plausibility bound, not a distance from the client clock: the two
// clocks here are the browser's and the bridge's, and a browser running minutes behind is
// ordinary. Rejecting stamps relative to local time would make that skew reject every real
// bridge timestamp, freezing the meters on the first reading and ignoring the 5s pushes that
// should replace it. Comparisons between candidates stay purely relative, so any shared offset
// cancels out and only a value that is not a plausible timestamp at all is discarded.
const MAX_PLAUSIBLE_STAMP_MS = Date.UTC(2100, 0, 1);

function usableStamp(sampledAtMs: number | undefined): number | null {
    if (typeof sampledAtMs !== "number" || !Number.isFinite(sampledAtMs)) return null;
    if (sampledAtMs <= 0 || sampledAtMs > MAX_PLAUSIBLE_STAMP_MS) return null;
    return sampledAtMs;
}

function freshestSample<T extends { sampled_at_ms?: number }>(candidates: T[]): T | undefined {
    let best: T | undefined;
    let bestStamp: number | null = null;
    for (const candidate of candidates) {
        const stamp = usableStamp(candidate.sampled_at_ms);
        if (best === undefined) {
            best = candidate;
            bestStamp = stamp;
            continue;
        }
        if (stamp === null) continue;
        if (bestStamp === null || stamp >= bestStamp) {
            best = candidate;
            bestStamp = stamp;
        }
    }
    return best;
}

// The usage meter leads with a synthetic "ctx" bar (context-window %), matching
// the v3/v4 mock where ctx is the first, emphasised meter; the rate limits follow.
export function buildUsageMeters(
    status: SessionStatus | undefined,
    limits: SessionStatus["limits"] | undefined,
    hostVitals?: HostVitals | null,
): NonNullable<SessionStatus["limits"]> {
    const meters: NonNullable<SessionStatus["limits"]> = [];
    // Synthetic ctx meter carries id "context" (drives short tag / rank / a11y name) plus
    // the raw used/limit pair (tokens/window) so the row can show e.g. 144k/200k.
    if (status?.context) {
        meters.push({
            id: "context",
            label: "context",
            percent: status.context.pct,
            used: status.context.tokens,
            limit: status.context.window,
        });
    }
    // Account subscription quotas only. Legacy host_cpu/host_ram entries (a bridge still
    // injecting synthetic host meters into limits[]) are held back here rather than pushed
    // through: they are folded into the host-meter resolution below so they compete on
    // FRESHNESS instead of double-rendering next to the vitals-derived pair.
    const legacyHostMeters = new Map<string, NonNullable<SessionStatus["limits"]>[number]>();
    if (limits?.length) {
        for (const limit of limits) {
            if (limit.id === "host_cpu" || limit.id === "host_ram") legacyHostMeters.set(limit.id, limit);
            else meters.push(limit);
        }
    }
    // Host CPU/RAM reach us from up to three places, and the right reading is the FRESHEST one,
    // never "whichever is present":
    //   1. legacy limits[] entries      — a pre-#156 or synthetic-injecting bridge
    // 2. status.vitals (top level) — the, shared with upstream + matron-apple
    // 3. the host_vitals push — fork-side, ~5s cadence, host-scoped across all convos
    // Presence is the wrong test for any of them, because none is ever cleared once seen:
    // mergeSessionStatus carries `vitals` across updates that omit it, and client.ts never drops
    // a cached push. So a bridge rollback that resumes sending newer limits[] host entries would,
    // under a presence test, be permanently masked by the retained older `vitals` — the header
    // would show stale telemetry on exactly the compatibility path this is meant to preserve.
    // Ranking every candidate by `sampled_at_ms` collapses that whole class: the newest sample
    // wins regardless of which source produced it, in either deploy direction.
    for (const id of ["host_cpu", "host_ram"] as const) {
        const candidates: NonNullable<SessionStatus["limits"]> = [];
        const legacy = legacyHostMeters.get(id);
        // A legacy entry is a full meter already (label, resets, the lot) — take it verbatim so
        // nothing a pre-#156 bridge sent is dropped in translation.
        if (legacy) candidates.push(legacy);
        const label = id === "host_cpu" ? "host CPU" : "host RAM";
        // Each half is narrowed on its own: the bridge sends `cpu_pct: null` until its sampler
        // has two ticks, and omits `cpu` from the push for the same reason, so a partial object
        // must still contribute the half it does have.
        const vitalsPercent = id === "host_cpu" ? status?.vitals?.cpu_pct : status?.vitals?.ram_pct;
        if (typeof vitalsPercent === "number" && Number.isFinite(vitalsPercent)) {
            candidates.push({ id, label, percent: vitalsPercent, sampled_at_ms: status?.vitals?.sampled_at_ms });
        }
        // The host-vitals push REFRESHES a host meter; it never creates one. A status source is what
        // establishes that this conversation shows host bars at all — the push is host-scoped,
        // carries no convo_id, and is deliberately not enough on its own.
        //
        // The gate is that source's PRESENCE (a `vitals` object, or a legacy limits[] entry),
        // not whether it produced a finite value for this particular half. The bridge sends
        // `cpu_pct: null` until its sampler has two ticks, and status only republishes at turn
        // end — so gating per-half would let a conversation that opened during warm-up sit
        // without a CPU bar indefinitely while valid pushes streamed past it.
        const hostMetersEnabled = candidates.length > 0 || Boolean(status?.vitals);
        const pushPercent = id === "host_cpu" ? hostVitals?.cpu : hostVitals?.ram;
        if (hostMetersEnabled && typeof pushPercent === "number" && Number.isFinite(pushPercent)) {
            candidates.push({ id, label, percent: pushPercent, sampled_at_ms: hostVitals?.sampled_at_ms });
        }
        const winner = freshestSample(candidates);
        if (winner) meters.push(winner);
    }
    const merged = meters;
    // Normalise to the design's column-first grid order (ctx/5h, fbl/model/wk, cpu/ram);
    // stable so any extra limits keep their relative order after the known ones.
    return merged
        .map((meter, index) => ({ meter, index }))
        .sort((a, b) => usageOrderRank(a.meter) - usageOrderRank(b.meter) || a.index - b.index)
        .map((entry) => entry.meter);
}

// "claude-sonnet-4-5" → "sonnet-4-5" for the <560 compact subtitle.
function shortModelName(model: string): string {
    return model.replace(/^(claude|gpt|openai|anthropic)[-/]/i, "").trim() || model;
}

export function UsageCluster({
    limits,
    now,
}: {
    limits: NonNullable<SessionStatus["limits"]>;
    now?: number;
}): React.ReactElement {
    const displayNow = useMinuteClock(now);
    return (
        <div className="mj_UsageBars" role="group" aria-label="Usage limits">
            {limits
                .filter((limit) => limit.label.trim())
                .map((limit, index) => {
                    const norm = normalizePercent(limit.percent);
                    const reset = resetDisplay(limit.resets_at, limit.resets, displayNow, limit.resets_at_ms);
                    const level = norm === null ? "unknown" : usageLevel(norm);
                    // Raw used/limit pair (ctx bar → e.g. 144k/200k). Not shown as the visible
                    // figure (operator wants the PERCENT visible like every other bar); kept
                    // only for the accessible aria-valuetext + a hover title.
                    const rawPair =
                        limit.used != null && limit.limit != null
                            ? `${compactTokens(limit.used)}/${compactTokens(limit.limit)}`
                            : undefined;
                    const accessibleLabel = usageAccessibleLabel(limit);
                    // Host vitals (host_cpu/host_ram) carry `sampled_at_ms` = their last real
                    // sample time. On an idle conversation the bridge replays a stale reading
                    // that looks live; expire it past HOST_VITALS_STALE_MS. Re-evaluated on the
                    // shared minute clock (displayNow) so it decays without a fresh frame. Non-
                    // host meters have no `sampled_at_ms` → never stale (current behaviour).
                    const stale = isSampleStale(limit.sampled_at_ms, displayNow);
                    const staleSuffix = stale
                        ? `, last sampled ${formatSampleAge(sampleAgeMs(limit.sampled_at_ms, displayNow) ?? 0)}`
                        : "";
                    const valueText =
                        norm === null
                            ? "usage unknown"
                            : `${norm}% used${rawPair ? `, ${rawPair}` : ""}${reset ? `, resets ${reset}` : ""}`;
                    // Hover title carries the raw pair (a11y-adjacent affordance) alongside
                    // any reset countdown; the visible figure is the percent only. Stale host
                    // readings append their sample age so the muted state is explained on hover.
                    const titleParts = [rawPair, reset ? `resets ${reset}` : undefined].filter(Boolean);
                    const title =
                        (titleParts.length ? titleParts.join(", ") : "") +
                        (stale ? `${titleParts.length ? "" : accessibleLabel}${staleSuffix}` : "");
                    return (
                        <div
                            className={`mj_UsageRow${stale ? " mj_UsageRow_stale" : ""}`}
                            key={index}
                            title={title || undefined}
                        >
                            {/* Visible label is the short tag; the accessible name keeps the
                                full server-authored label so SR users know which limit it is.
                                A stale host reading folds its sample age into the accessible
                                name so SR users hear it (visible bar is just dimmed). */}
                            <span className="mj_UsageLabel" aria-hidden="true">
                                {usageShortLabel(limit)}
                            </span>
                            <span
                                className="mj_UsageTrack"
                                role="progressbar"
                                aria-label={`${accessibleLabel}${staleSuffix}`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={norm ?? undefined}
                                aria-valuetext={valueText}
                            >
                                <span
                                    className={`mj_UsageFill mj_UsageFill_${level}`}
                                    style={{ width: norm === null ? "100%" : `${norm}%` }}
                                />
                            </span>
                            <span className={`mj_UsagePercent mj_UsagePercent_${level}`}>
                                {norm === null ? "—" : `${Math.round(norm)}%`}
                            </span>
                            {/* Reset time trailing the bar, as the Mac header shows it. Visible
                                only: the progressbar's value text already announces it. */}
                            {reset && (
                                <span className="mj_UsageReset" aria-hidden="true">
                                    {reset}
                                </span>
                            )}
                        </div>
                    );
                })}
        </div>
    );
}

// A header disclosure. It opens on hover (pointer) OR click/keyboard, but only
// click/keyboard activation ("pinned") moves focus into the panel — hovering must
// never steal focus from e.g. the composer. Hover-open dismisses on mouse-leave;
// pinned-open dismisses on Escape, outside-click, or focus leaving the group.
// Wrapping `before` (e.g. the h1) + trigger + panel in one relatively-positioned
// group lets the mouse travel from the trigger into the panel without closing.
function HeaderDisclosure({
    className,
    triggerClassName,
    panelClassName,
    label,
    before,
    trigger,
    children,
    headerRef,
}: {
    className: string;
    triggerClassName: string;
    panelClassName: string;
    label: string;
    before?: React.ReactNode;
    trigger: React.ReactNode;
    children: React.ReactNode;
    headerRef: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
    const [hoverOpen, setHoverOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const open = hoverOpen || pinned;
    const openerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const popoverId = useId();
    const close = useCallback(() => {
        setHoverOpen(false);
        setPinned(false);
    }, []);
    useDismissablePopover(open, close, { openerRef, panelRef });
    // Tapping the trigger again closes it (and focus returns to the trigger, not <body>).
    const toggle = usePressToggle(pinned, (next) => {
        if (next) {
            setPinned(true);
        } else {
            close();
            openerRef.current?.focus();
        }
    });
    // Hover-open is for a mouse only. A touch tap also fires compatibility mouse events, which
    // hover-opened the panel underneath the pinned one, so a second tap unpinned it and it stayed
    // open. The pointer type is known (pointerenter / pointerdown) before those mouse events fire.
    const lastPointerRef = useRef<string | null>(null);
    const notePointer = (event: React.PointerEvent): void => {
        lastPointerRef.current = event.pointerType;
    };
    // Move focus into the panel ONLY for click/keyboard activation — never on hover.
    useLayoutEffect(() => {
        if (pinned) panelRef.current?.focus();
    }, [pinned]);
    // If this disclosure unmounts (its band exited) while pinned — focus is inside
    // it — restore focus to the stable header before the browser drops it to <body>.
    const pinnedRef = useRef(pinned);
    pinnedRef.current = pinned;
    useEffect(
        () => () => {
            if (pinnedRef.current) headerRef.current?.focus();
        },
        [headerRef],
    );
    return (
        <div
            className={className}
            onPointerEnter={notePointer}
            onPointerDown={notePointer}
            onMouseEnter={() => {
                if (lastPointerRef.current === null || lastPointerRef.current === "mouse") setHoverOpen(true);
            }}
            onMouseLeave={() => setHoverOpen(false)}
            onBlur={(event) => {
                // Focus left the whole disclosure (tabbed away) → unpin + close.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
            }}
        >
            {before}
            <button
                ref={openerRef}
                type="button"
                className={triggerClassName}
                aria-label={label}
                aria-expanded={open}
                aria-controls={popoverId}
                onPointerDown={toggle.onPointerDown}
                onKeyDown={toggle.onKeyDown}
                onClick={toggle.onClick}
            >
                {trigger}
            </button>
            {open && (
                <div
                    ref={panelRef}
                    id={popoverId}
                    className={panelClassName}
                    role="group"
                    aria-label={label}
                    tabIndex={-1}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

/** The title cluster alone, or in a row with the control beside it (the mission chip). */
function withAccessory(cluster: React.ReactElement, accessory: React.ReactNode): React.ReactElement {
    if (!accessory) return cluster;
    return (
        <div className="mj_HeaderTitleRow">
            {cluster}
            {accessory}
        </div>
    );
}

export function HeaderShell({
    mode,
    onBack,
    backLabel,
    title,
    titleNode,
    titleGlyph,
    titleBadge,
    titleAccessory,
    subtitle,
    subtitleCompact,
    hasSubtitle,
    limits,
    rightControls,
    persistentControls,
    hideControlsWhenCompact = false,
    collapse,
}: {
    mode: "parent" | "child";
    onBack: () => void;
    backLabel: string;
    title: string;
    /** Rendered title (session tag + stripped title); `title` stays the plain string for tooltips. */
    titleNode?: React.ReactNode;
    // Optional glyph before the title (child view: ↳) and a badge after it (SUBAGENT). §10.11
    // requires the header to name the SUBAGENT when inside one — never the parent.
    titleGlyph?: React.ReactNode;
    titleBadge?: React.ReactNode;
    /** A control beside the title, outside the heading (the mission chip). */
    titleAccessory?: React.ReactNode;
    subtitle: React.ReactNode;
    subtitleCompact?: React.ReactNode;
    hasSubtitle: boolean;
    limits?: NonNullable<SessionStatus["limits"]>;
    rightControls?: React.ReactNode;
    // Rendered even at the compact breakpoint (unlike rightControls) — for affordances
    // that must stay reachable on narrow/mobile where the sidebar menu is also hidden.
    persistentControls?: React.ReactNode;
    hideControlsWhenCompact?: boolean;
    collapse: { usageCollapsed: boolean; titleCollapsed: boolean };
}): React.ReactElement {
    const { usageCollapsed, titleCollapsed } = collapse;
    const headerRef = useRef<HTMLElement>(null);
    const now = useMinuteClock();
    const titleHeadingId = useId();

    // Collapsed usage keeps two rows — ctx + the 5h (Session) limit — since the header
    // band has the height for two and one bar reads as too little (operator's call).
    // Pin BOTH by stable id, NOT by grid position: host cpu/ram now sort to limits[0]
    // so a positional pick would collapse to cpu/ram. Match the
    // short-tag heuristic as a fallback for older/cached frames that lack ids.
    const ctxMeter = limits?.find((meter) => meter.id === "context" || (!meter.id && usageShortLabel(meter) === "ctx"));
    const sessionMeter = limits?.find(
        (meter) => meter.id === "session" || (!meter.id && usageShortLabel(meter) === "5h"),
    );
    // ctx first, then 5h — pinned by id above. If a degenerate frame carries neither
    // (limits present but no ctx/5h), fall back to the first meter so the collapsed
    // disclosure still renders instead of vanishing.
    const collapsedMeters = [ctxMeter, sessionMeter].filter((meter): meter is NonNullable<typeof meter> =>
        Boolean(meter),
    );
    if (collapsedMeters.length === 0 && limits?.length) collapsedMeters.push(limits[0]);
    const hasCollapsedUsage = collapsedMeters.length > 0;
    const worst = limits ? worstLimit(limits) : undefined;
    const worstNormalized = worst ? (normalizePercent(worst.percent) ?? 0) : undefined;
    const worstReset = worst ? resetDisplay(worst.resets_at, worst.resets, now, worst.resets_at_ms) : "";
    const usageLabel =
        worstNormalized === undefined
            ? "Usage — all metrics"
            : `Usage — worst limit ${Math.round(worstNormalized)}%${worstReset ? `, resets ${worstReset}` : ""}`;

    const controls = titleCollapsed && hideControlsWhenCompact ? null : rightControls;

    return (
        <header ref={headerRef} className={`mj_ChatHeader${mode === "child" ? " mj_SubChatHeader" : ""}`} tabIndex={-1}>
            <button type="button" className="mj_BackButton" onClick={onBack} aria-label={backLabel}>
                <ChevronLeftIcon />
            </button>
            {withAccessory(
                titleCollapsed ? (
                    <HeaderDisclosure
                        className="mj_HeaderCluster mj_HeaderTitleCluster mj_HeaderTitleCluster_compact"
                        triggerClassName="mj_HeaderTitleDisclosure"
                        panelClassName="mj_HeaderMenu mj_TitlePopover"
                        label="Conversation details"
                        headerRef={headerRef}
                        before={
                            <div
                                id={titleHeadingId}
                                dir="auto"
                                role="heading"
                                aria-level={1}
                                className="mj_ChatHeader_heading"
                                title={title}
                            >
                                {titleGlyph && (
                                    <span className="mj_HeaderTitleGlyph" aria-hidden="true">
                                        {titleGlyph}
                                    </span>
                                )}
                                <span className="mj_ChatHeader_truncated mj_lineClamp">{titleNode ?? title}</span>
                                {titleBadge}
                            </div>
                        }
                        trigger={
                            <>
                                {subtitleCompact}
                                <ChevronDownIcon aria-hidden="true" />
                            </>
                        }
                    >
                        <div className="mj_TitlePopoverTitle">{title}</div>
                        {hasSubtitle && <div className="mj_HeaderMeta">{subtitle}</div>}
                    </HeaderDisclosure>
                ) : (
                    <div className="mj_HeaderCluster mj_HeaderTitleCluster">
                        <div
                            id={titleHeadingId}
                            dir="auto"
                            role="heading"
                            aria-level={1}
                            className="mj_ChatHeader_heading"
                        >
                            {titleGlyph && (
                                <span className="mj_HeaderTitleGlyph" aria-hidden="true">
                                    {titleGlyph}
                                </span>
                            )}
                            <span className="mj_ChatHeader_truncated mj_lineClamp">{titleNode ?? title}</span>
                            {titleBadge}
                        </div>
                        {hasSubtitle && <div className="mj_HeaderMeta">{subtitle}</div>}
                    </div>
                ),
                titleAccessory,
            )}
            <div className="mj_HeaderControls">
                {usageCollapsed && hasCollapsedUsage ? (
                    <HeaderDisclosure
                        className="mj_HeaderUsageDisclosure"
                        triggerClassName="mj_HeaderCluster mj_UsageCluster mj_UsageCluster_collapsed"
                        panelClassName="mj_HeaderMenu mj_UsagePopover"
                        label={usageLabel}
                        headerRef={headerRef}
                        trigger={<UsageCluster limits={collapsedMeters} now={now} />}
                    >
                        <UsageCluster limits={limits ?? []} now={now} />
                    </HeaderDisclosure>
                ) : limits?.length ? (
                    <div className="mj_HeaderCluster mj_UsageCluster">
                        <UsageCluster limits={limits} now={now} />
                    </div>
                ) : null}
                {(controls || persistentControls) &&
                    (Boolean(limits?.length) || Boolean(usageCollapsed && hasCollapsedUsage)) && (
                        <span className="mj_HeaderDivider" aria-hidden="true" />
                    )}
                {controls}
                {persistentControls}
            </div>
        </header>
    );
}

/**
 * "Enable browser tools" confirm (redesign v6 surface B) on the upload-confirm shell. One
 * primary ("Restart with browser tools"); "Restart now" appears only while the agent is
 * mid-task and stops the current step instead of waiting. Focus lands on the primary; Escape
 * and Cancel return focus to the header ⋯.
 */
function BrowserToolsConfirm({
    busy,
    onConfirm,
    onClose,
}: {
    busy: boolean;
    /** Resolves false when the command couldn't be queued; the dialog stays open and says so. */
    onConfirm: (now: boolean) => Promise<boolean>;
    onClose: () => void;
}): React.ReactElement {
    const primaryRef = useRef<HTMLButtonElement>(null);
    const scrimRef = useRef<HTMLDivElement>(null);
    useFocusTrap(scrimRef);
    const dialogRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string>();
    const [sending, setSending] = useState(false);
    // Focus lands on the primary, and returns there if "Restart now" disappears under it.
    useLayoutEffect(() => {
        if (!dialogRef.current?.contains(document.activeElement)) primaryRef.current?.focus();
    }, [busy]);
    const confirm = (now: boolean): void => {
        if (sending) return;
        setSending(true);
        setError(undefined);
        void onConfirm(now).then(
            (sent) => {
                setSending(false);
                if (!sent) setError("Couldn’t send the restart. Try again.");
            },
            () => {
                setSending(false);
                setError("Couldn’t send the restart. Try again.");
            },
        );
    };
    return (
        <div
            ref={scrimRef}
            className="mj_UploadConfirm_scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }}
        >
            <div
                ref={dialogRef}
                className="mj_UploadConfirm mj_UploadConfirm_queue mj_BrowserToolsConfirm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mj-browser-tools-title"
            >
                <header className="mj_UploadConfirm_header">
                    <V6Icon name="globe" className="mj_UploadConfirm_uploadIcon" />
                    <h2 className="mj_UploadConfirm_title" id="mj-browser-tools-title">
                        Enable browser tools
                    </h2>
                    <span className="mj_UploadConfirm_headerSpacer" />
                    <button type="button" className="mj_UploadConfirm_close" aria-label="Close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </header>
                <div className="mj_UploadConfirm_body">
                    <p>
                        Matron restarts this session with browser tools, so the agent can take screenshots and use web
                        pages.
                    </p>
                    <ul className="mj_ConfirmList">
                        <li>
                            <V6Icon name="chat" />
                            <span>The conversation is kept.</span>
                        </li>
                        <li>
                            <V6Icon name="memory" />
                            <span>Browser tools use about 400 MB of memory while on.</span>
                        </li>
                    </ul>
                    {busy && (
                        <div className="mj_ConfirmBusy">
                            <span className="mj_LiveDot" aria-hidden="true" />
                            <span>
                                The agent is in the middle of a task. The restart waits until it finishes.{" "}
                                <b>Restart now</b> stops the current step instead.
                            </span>
                        </div>
                    )}
                    {error && (
                        <p className="mj_UploadConfirm_error" role="alert">
                            {error}
                        </p>
                    )}
                </div>
                <footer className="mj_UploadConfirm_footer">
                    <div className="mj_UploadConfirm_actions">
                        <button type="button" onClick={onClose}>
                            Cancel
                        </button>
                        {busy && (
                            <button
                                type="button"
                                className="mj_UploadConfirm_skip"
                                disabled={sending}
                                onClick={() => confirm(true)}
                            >
                                Restart now
                            </button>
                        )}
                        <button
                            ref={primaryRef}
                            type="button"
                            className="mj_UploadConfirm_send"
                            disabled={sending}
                            onClick={() => confirm(false)}
                        >
                            Restart with browser tools
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
}

/** The session-menu row for browser tools, in its five states (v6 component-map). */
function BrowserToolsItem({
    state,
    codex,
    busy,
    onEnable,
}: {
    state: BrowserToolsState;
    codex: boolean;
    /** The agent is mid-turn: a queued restart can still be forced via the dialog's "Restart now". */
    busy: boolean;
    onEnable: () => void;
}): React.ReactElement {
    const on = !codex && state === "on";
    // Round 2: no descriptive hint; a hint only when it gives the reason an item is disabled.
    const hint = codex
        ? "Not available for Codex sessions"
        : state === "queued"
          ? "Restarting after this step"
          : state === "restarting"
            ? "Restarting…"
            : undefined;
    // A queued restart stays reachable while the agent is busy: the dialog's "Restart now" is the way out of the wait.
    const disabled = codex || (state !== "idle" && !(state === "queued" && busy));
    return (
        <button
            className={`mj_ConversationMenu_item${hint ? " mj_ConversationMenu_item_hinted" : ""}`}
            type="button"
            role={on ? "menuitemcheckbox" : "menuitem"}
            aria-checked={on ? true : undefined}
            aria-disabled={disabled || undefined}
            onClick={() => {
                if (!disabled) onEnable();
            }}
        >
            <V6Icon name={on ? "check" : "globe"} />
            <span className="mj_MenuText">
                <span className="mj_MenuLabel">{on ? "Browser tools on" : "Enable browser tools"}</span>
                {hint && <span className="mj_MenuHint">{hint}</span>}
            </span>
        </button>
    );
}
// The items a header menu's arrow keys walk: actions, the level choices' radio items, and the
// browser-tools row's checkbox item (every role starting "menuitem").
const MENU_ITEM_SELECTOR = '[role^="menuitem"]';

// Header "⋯" overflow: the selected conversation's actions (same set as the sidebar
// row menu), opened by click only (never hover — these mutate state).
function HeaderOverflowMenu({
    client,
    conversation,
    state,
    extras,
}: {
    client: MatronJournalClient;
    conversation: Conversation;
    state: ClientState;
    /** Sections shown above the actions (the folded Rooms and bell); `pick` closes the menu,
     *  runs the choice and gives focus back to the ⋯ button. */
    extras?: (pick: (run: () => void) => void) => React.ReactNode;
}): React.ReactElement {
    const [open, setOpen] = useState(false);
    const [confirmBrowser, setConfirmBrowser] = useState(false);
    const openerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const restoreFrameRef = useRef<number | undefined>(undefined);
    const busy = conversation.session_state === "running";
    const codex = conversation.agent_kind === "codex";
    const statusExtras = state.sessionStatus?.extras;
    const browserState = useMemo(
        () => browserToolsState(state.events, busy, statusExtras),
        [state.events, busy, statusExtras],
    );
    const close = useCallback(() => setOpen(false), []);
    useDismissablePopover(open, close, { openerRef, panelRef });
    const toggle = usePressToggle(open, (next) => {
        setOpen(next);
        if (!next) openerRef.current?.focus();
    });
    useLayoutEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
    }, [open]);
    // Cancel any pending focus-restore frame on unmount so a leaked callback
    // can't fire after this menu is gone and steal focus (upstream's guard,
    // lost on a prior fork-sync — the act() rAF below had regressed to a bare,
    // uncancellable frame).
    useEffect(
        () => () => {
            if (restoreFrameRef.current != null) cancelAnimationFrame(restoreFrameRef.current);
        },
        [],
    );

    const [pinDialog, setPinDialog] = useState<PinDialogTarget>();
    const id = conversation.id;
    const journalPinned = state.journalPins?.some((pin) => pin.convo_id === id) ?? false;
    const isPinned = state.pinnedIds.has(id);
    const isFavorite = state.favoriteIds.has(id);
    const isArchived = state.archivedIds.has(id);
    const isUnread = effectiveUnread(conversation, state.unreadOverrideIds);
    const act = (run: () => void): void => {
        const opener = openerRef.current;
        close();
        run();
        // Defer past the re-render: a non-navigating action (pin/favorite/read) keeps the
        // opener mounted → restore focus to it; archiving the selected conversation clears
        // selection and unmounts this whole header, so skip rather than focus a dead node.
        // Cancel any in-flight frame before scheduling a new one and clear the ref when it
        // runs, so rapid actions can't leave a stale callback to fire after unmount.
        if (restoreFrameRef.current != null) cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = requestAnimationFrame(() => {
            restoreFrameRef.current = undefined;
            if (opener?.isConnected) opener.focus();
        });
    };

    // Opening a pin sheet skips act()'s focus restore: the sheet's field takes focus instead.
    const openPinDialog = (target: PinDialogTarget): void => {
        close();
        setPinDialog(target);
    };

    return (
        <div
            className="mj_HeaderOverflow"
            onBlur={(event) => {
                // Tab / Shift+Tab out of the menu closes it (focus left the whole control).
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
            }}
        >
            <button
                ref={openerRef}
                type="button"
                className="mj_IconButton mj_HeaderOverflowTrigger"
                aria-label="Conversation actions"
                aria-haspopup="menu"
                aria-expanded={open}
                onPointerDown={toggle.onPointerDown}
                onKeyDown={toggle.onKeyDown}
                onClick={toggle.onClick}
            >
                <KebabIcon aria-hidden />
            </button>
            {open && (
                <div
                    className={`mj_HeaderMenu mj_ConversationMenu${extras ? " mj_ConversationMenu_withSections" : ""}`}
                    role="menu"
                    ref={panelRef}
                    onKeyDown={(event) => {
                        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
                        const currentIndex = items.findIndex((item) => item === document.activeElement);
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            const direction = event.key === "ArrowDown" ? 1 : -1;
                            const nextIndex =
                                currentIndex === -1
                                    ? event.key === "ArrowDown"
                                        ? 0
                                        : items.length - 1
                                    : (currentIndex + direction + items.length) % items.length;
                            items[nextIndex]?.focus();
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                            openerRef.current?.focus();
                        }
                    }}
                >
                    {extras?.(act)}
                    {state.journalPins ? (
                        journalPinned ? (
                            <>
                                <button
                                    className="mj_ConversationMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => openPinDialog({ kind: "edit", convoId: id })}
                                >
                                    <FileEditIcon aria-hidden />
                                    Edit pin…
                                </button>
                                <button
                                    className="mj_ConversationMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => openPinDialog({ kind: "move", convoId: id })}
                                >
                                    <PinIcon aria-hidden />
                                    Move pin…
                                </button>
                                <button
                                    className="mj_ConversationMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => act(() => void client.removePin(id))}
                                >
                                    <PinIcon aria-hidden />
                                    Unpin
                                </button>
                            </>
                        ) : (
                            <button
                                className="mj_ConversationMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => openPinDialog({ kind: "edit", convoId: id })}
                            >
                                <PinIcon aria-hidden />
                                Pin to sidebar…
                            </button>
                        )
                    ) : (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() =>
                                act(() => (isPinned ? client.unpinConversation(id) : client.pinConversation(id)))
                            }
                        >
                            <PinIcon aria-hidden />
                            {isPinned ? "Unpin" : "Pin"}
                        </button>
                    )}
                    <button
                        className="mj_ConversationMenu_item"
                        type="button"
                        role="menuitem"
                        onClick={() =>
                            act(() =>
                                isFavorite ? client.unfavoriteConversation(id) : client.favoriteConversation(id),
                            )
                        }
                    >
                        {isFavorite ? <StarFilledIcon aria-hidden /> : <StarIcon aria-hidden />}
                        {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                    </button>
                    {!isArchived && (
                        <button
                            className="mj_ConversationMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() =>
                                act(() =>
                                    isUnread ? client.markConversationRead(id) : client.markConversationUnread(id),
                                )
                            }
                        >
                            {isUnread ? <MarkReadIcon aria-hidden /> : <MarkUnreadIcon aria-hidden />}
                            {isUnread ? "Mark as read" : "Mark as unread"}
                        </button>
                    )}
                    {/* Hidden, never guessed, until the bridge reports the session's extras. */}
                    {statusExtras !== undefined && (
                        <BrowserToolsItem
                            state={browserState}
                            codex={codex}
                            busy={busy}
                            onEnable={() => {
                                close();
                                setConfirmBrowser(true);
                            }}
                        />
                    )}
                    <MenuSeparator />
                    <button
                        className="mj_ConversationMenu_item"
                        type="button"
                        role="menuitem"
                        onClick={() =>
                            act(() => (isArchived ? client.unarchiveConversation(id) : client.archiveConversation(id)))
                        }
                    >
                        {isArchived ? <UnarchiveIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
                        {isArchived ? "Unarchive" : "Archive"}
                    </button>
                </div>
            )}
            {confirmBrowser && (
                <BrowserToolsConfirm
                    busy={busy}
                    onClose={() => {
                        setConfirmBrowser(false);
                        openerRef.current?.focus();
                    }}
                    onConfirm={async (now) => {
                        const sent = await client.sendMessage(
                            now ? BROWSER_RESTART_NOW_COMMAND : BROWSER_RESTART_COMMAND,
                            id,
                        );
                        if (sent) {
                            setConfirmBrowser(false);
                            openerRef.current?.focus();
                        }
                        return sent;
                    }}
                />
            )}
            {pinDialog && (
                <PinDialog client={client} state={state} target={pinDialog} onClose={() => setPinDialog(undefined)} />
            )}
        </div>
    );
}

// Backstop for the compact in-flight pulse. Compaction emits no incremental
// progress signal, so the pulse is cleared by the post-compact status frame (context
// tokens drop below the pre-send baseline). This timeout is the fallback for when that
// never arrives — e.g. snap-compact declines because pressure is <50%, or already
// compacted this session — so the indeterminate state can never stick on forever.
const COMPACT_PULSE_TIMEOUT_MS = 180_000;

// The header Compact pill. Sends /snap-compact — the guided safe-compact flow that
// pre-checks pressure and assembles preserve instructions — rather than a raw /compact,
// and shows an INDETERMINATE "Compacting…" pulse while the compaction is in flight (NOT a
// percentage fill; /compact reports no incremental progress). The pulse clears when the
// next status frame reports fewer context tokens than the pre-send baseline, or on the
// timeout backstop above.
function CompactButton({
    client,
    contextTokens,
    iconOnly = false,
}: {
    client: MatronJournalClient;
    contextTokens: number;
    /** Too narrow for the label: the header folds the pill to its icon. */
    iconOnly?: boolean;
}): React.ReactElement {
    const [compacting, setCompacting] = useState(false);
    const baselineRef = useRef<number | null>(null);

    useEffect(() => {
        if (!compacting) return;
        // Compaction landed: the fresh status frame reports a smaller context than the
        // token count captured at send time → clear the pulse.
        if (baselineRef.current != null && contextTokens < baselineRef.current) {
            setCompacting(false);
            return;
        }
        const timeout = window.setTimeout(() => setCompacting(false), COMPACT_PULSE_TIMEOUT_MS);
        return () => window.clearTimeout(timeout);
    }, [compacting, contextTokens]);

    const onClick = useCallback(() => {
        baselineRef.current = contextTokens;
        setCompacting(true);
        void client.sendMessage("/snap-compact").catch((error) => {
            console.warn("Snap-compact command failed to send:", error);
            setCompacting(false);
        });
    }, [client, contextTokens]);

    return (
        <button
            className={`mj_CompactButton${compacting ? " mj_CompactButton_compacting" : ""}${iconOnly ? " mj_CompactButton_iconOnly" : ""}`}
            type="button"
            aria-label="Compact conversation"
            aria-busy={compacting}
            title="Compact the conversation — sends /snap-compact"
            disabled={compacting}
            onClick={onClick}
        >
            <CompactIcon aria-hidden />
            {!iconOnly && <span>{compacting ? "Compacting…" : "Compact"}</span>}
        </button>
    );
}

// True when a limit carries any reset timestamp the countdown can render.
function hasResetTime(limit: NonNullable<SessionStatus["limits"]>[number]): boolean {
    return limit.resets_at_ms != null || limit.resets_at != null || Boolean(limit.resets);
}

// The usage-window limit whose reset time the header countdown tracks: the
// 5-hour session window first, falling back to the soonest listed rate limit that carries
// a reset (excluding the synthetic context bar and the host cpu/ram meters, which have no
// meaningful reset). Reuses the reset data already flowing to the pressure bars — no new
// data source or request.
function pickResetLimit(
    limits: NonNullable<SessionStatus["limits"]>,
): NonNullable<SessionStatus["limits"]>[number] | undefined {
    const session = limits.find((limit) => limit.id === "session" && hasResetTime(limit));
    if (session) return session;
    return limits.find(
        (limit) => limit.id !== "context" && limit.id !== "host_cpu" && limit.id !== "host_ram" && hasResetTime(limit),
    );
}

// The weekly usage-window limit whose reset the header shows alongside the 5-hour one:
// week_all ("weekly, all models") first, else the soonest listed week_<slug> that carries a
// reset. Same data as the pressure bars — no new source or request.
function pickWeekResetLimit(
    limits: NonNullable<SessionStatus["limits"]>,
): NonNullable<SessionStatus["limits"]>[number] | undefined {
    const all = limits.find((limit) => limit.id === "week_all" && hasResetTime(limit));
    if (all) return all;
    return limits.find((limit) => typeof limit.id === "string" && /^week_/.test(limit.id) && hasResetTime(limit));
}

// The 5-hour session limit specifically (strict — no fallback), so its countdown is never
// mislabelled as "5h" when the frame only carries other windows.
function pick5hResetLimit(
    limits: NonNullable<SessionStatus["limits"]>,
): NonNullable<SessionStatus["limits"]>[number] | undefined {
    return limits.find((limit) => limit.id === "session" && hasResetTime(limit));
}

// Header subtitle countdown that replaces the workdir path: shows BOTH usage
// windows when present — "resets 5h 3h05 / wk Wed 5pm" — the 5-hour session limit and the
// weekly (all-models) limit. Shows a single segment when only one window carries a reset,
// and falls back to the prior soonest-reset chip for frames with neither (a bare rate
// limit). Renders nothing when no usage-window reset is available. Same reset data as the
// pressure bars — no new source.
function LimitsResetIndicator({ limits }: { limits: SessionStatus["limits"] }): React.ReactElement | null {
    const now = useMinuteClock();
    const fiveHLimit = limits ? pick5hResetLimit(limits) : undefined;
    const weekLimit = limits ? pickWeekResetLimit(limits) : undefined;
    const fiveH = fiveHLimit ? resetDisplay(fiveHLimit.resets_at, fiveHLimit.resets, now, fiveHLimit.resets_at_ms) : "";
    const week = weekLimit ? resetDisplay(weekLimit.resets_at, weekLimit.resets, now, weekLimit.resets_at_ms) : "";
    if (fiveH || week) {
        // Compact: bare values, no inline "5h"/"wk" labels — the short countdown reads as the
        // 5-hour window and the weekday/absolute token as the weekly one. The tooltip carries
        // the semantics. Order is always 5h then weekly.
        const value = [fiveH, week].filter(Boolean).join(" / ");
        return (
            <span className="mj_HeaderLimitsReset" title="Usage-window limits reset — 5-hour / weekly">
                {`resets ${value}`}
            </span>
        );
    }
    // Neither the 5h nor a weekly window is in this frame — preserve the prior single chip
    // (the soonest listed reset, e.g. a bare model/fbl rate limit).
    const fallback = limits ? pickResetLimit(limits) : undefined;
    const value = fallback ? resetDisplay(fallback.resets_at, fallback.resets, now, fallback.resets_at_ms) : "";
    if (!value) return null;
    // resetDisplay yields a relative token ("3h05", "45m") or an absolute one ("Wed 5pm",
    // "now"); only the relative digit-leading form reads well with the "in" preposition.
    const label = /^\d/.test(value) ? `limits reset in ${value}` : `limits reset ${value}`;
    return (
        <span className="mj_HeaderLimitsReset" title="Usage-window limits reset">
            {label}
        </span>
    );
}

/** The least of a mission name worth drawing in the chip; with less room it reads "#12 S…", so the
 *  chip shows "#12 +2" instead (the Mac's minimumNameWidth). */
const CHIP_MIN_NAME_PX = 40;
const CHIP_MAX_PX = 240;
const CHIP_TITLE_STUB_REM = 6;

/**
 * How the chip fits beside the conversation title: the title comes first and the chip takes what it
 * leaves. The name shows while there is room for at least CHIP_MIN_NAME_PX of it, else the chip
 * reads "#12 +2" rather than "#12 S…"; and the chip keeps that number-only width (`minWidth`) unless
 * even that would push the title below its stub, when the chip is hidden (`minWidth` null). Measured from the
 * title row (the chip's parent), since which of the two gives way depends on both their lengths.
 */
function useChipFit(
    triggerRef: React.RefObject<HTMLButtonElement | null>,
    name: string | null,
): { nameFits: boolean; minWidth: number | null } {
    const [fit, setFit] = useState<{ nameFits: boolean; minWidth: number | null }>({ nameFits: true, minWidth: null });
    useLayoutEffect(() => {
        const trigger = triggerRef.current;
        const row = trigger?.parentElement?.parentElement;
        const nameEl = trigger?.querySelector<HTMLElement>(".mj_MissionChip_name");
        if (!trigger || !row || !nameEl) return;
        const measure = (): void => {
            const title = row.firstElementChild as HTMLElement | null;
            const heading = title?.querySelector<HTMLElement>(".mj_ChatHeader_heading");
            const meta = title?.querySelector<HTMLElement>(".mj_HeaderMeta, .mj_HeaderTitleDisclosure");
            const titleWant = Math.max(heading?.scrollWidth ?? 0, meta?.scrollWidth ?? 0);
            // The title's stub: `min-width: min(6rem, 100%)` on the title cluster in the CSS.
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const titleStub = Math.min(titleWant, CHIP_TITLE_STUB_REM * rem);
            const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
            // The chip without its name ("#12 +2"), and with all of it, capped like the CSS.
            const numberOnly = Math.ceil(trigger.scrollWidth - nameEl.getBoundingClientRect().width);
            const full = Math.min(CHIP_MAX_PX, numberOnly + (name ? nameEl.scrollWidth + 4 : 0));
            const room = row.clientWidth - titleWant - gap;
            const nameFits = !!name && (room >= full || room >= numberOnly + CHIP_MIN_NAME_PX);
            const minWidth = row.clientWidth - titleStub - gap >= numberOnly ? numberOnly : null;
            setFit((prev) =>
                prev.nameFits === nameFits && prev.minWidth === minWidth ? prev : { nameFits, minWidth },
            );
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        const heading = row.firstElementChild?.querySelector(".mj_ChatHeader_heading");
        if (heading) observer.observe(heading);
        return () => observer.disconnect();
    }, [triggerRef, name]);
    return fit;
}

// The chat header's mission chip, after the Mac's: "⚑ #12 Ship the docs +2 ▾" names the
// conversation's current mission (else its newest), and opens every mission the conversation
// touched as Current / Also on / Earlier. Picking one opens its mission page. Hidden while the
// conversation has never been on a mission, and until its missions are fetched.
export function MissionChip({
    client,
    conversation,
    links,
}: {
    client: MatronJournalClient;
    conversation: Conversation;
    links: readonly ConversationMissionLink[];
}): React.ReactElement | null {
    const [open, setOpen] = useState(false);
    const openerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismissablePopover(open, close, { openerRef, panelRef });
    useLayoutEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [open]);

    const label = chipLabel(links, conversation.title);
    const fit = useChipFit(openerRef, label?.name ?? null);
    if (!label) return null;
    const sections = missionSections(links);
    const headline = chipHeadline(sections)!;
    const groups: Array<[string, ConversationMissionLink[]]> = [
        ["Current", sections.current ? [sections.current] : []],
        ["Also on", sections.alsoOn],
        ["Earlier", sections.earlier],
    ];
    const openMission = (num: number): void => {
        close();
        client.openTrackerMission(num);
    };
    const accessible =
        `Mission ${headline.num}, ${headline.title}` +
        (label.others > 0 ? `, and ${label.others} more` : "") +
        ". Every mission this conversation worked on";

    return (
        <div
            className={`mj_MissionChip${fit.minWidth == null ? " mj_MissionChip_hidden" : ""}`}
            style={fit.minWidth != null ? { minWidth: fit.minWidth } : undefined}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
            }}
        >
            <button
                ref={openerRef}
                type="button"
                className={`mj_MissionChip_trigger${headline.current ? " mj_MissionChip_trigger_current" : ""}`}
                aria-label={accessible}
                title="Every mission this conversation worked on"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
            >
                <ProjectsIcon className="mj_MissionChip_flag" aria-hidden="true" />
                <span className="mj_MissionChip_num">{label.number}</span>
                {/* Always rendered, empty when unused: the chip's grid has a fixed column for each. */}
                <span className={`mj_MissionChip_name${fit.nameFits ? "" : " mj_MissionChip_name_hidden"}`}>
                    {label.name ?? ""}
                </span>
                <span className="mj_MissionChip_more">{label.others > 0 ? `+${label.others}` : ""}</span>
                <ChevronDownIcon className="mj_MissionChip_chevron" aria-hidden="true" />
            </button>
            {open && (
                <div
                    className="mj_HeaderMenu mj_MissionMenu"
                    role="menu"
                    aria-label="Missions"
                    ref={panelRef}
                    onKeyDown={(event) => {
                        const items = Array.from(
                            event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
                        );
                        const index = items.findIndex((item) => item === document.activeElement);
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            const step = event.key === "ArrowDown" ? 1 : -1;
                            const next =
                                index === -1
                                    ? step === 1
                                        ? 0
                                        : items.length - 1
                                    : (index + step + items.length) % items.length;
                            items[next]?.focus();
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                            openerRef.current?.focus();
                        }
                    }}
                >
                    {groups.map(([groupLabel, rows]) =>
                        rows.length === 0 ? null : (
                            <div key={groupLabel} className="mj_MissionMenu_group" role="group" aria-label={groupLabel}>
                                <div className="mj_MissionMenu_label" aria-hidden="true">
                                    {groupLabel}
                                </div>
                                {rows.map((link) => (
                                    <button
                                        key={link.id}
                                        type="button"
                                        role="menuitem"
                                        className={`mj_MissionMenu_item${isEarlierLink(link) ? " mj_MissionMenu_item_earlier" : ""}`}
                                        onClick={() => openMission(link.num)}
                                    >
                                        <span className="mj_MissionMenu_title">
                                            <span className="mj_MissionMenu_num">#{link.num}</span> {link.title}
                                        </span>
                                        <span className="mj_MissionMenu_line">{linkLine(link)}</span>
                                    </button>
                                ))}
                            </div>
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

function ChatHeader({
    client,
    state,
    collapse = { usageCollapsed: false, titleCollapsed: false },
}: {
    client: MatronJournalClient;
    state: ClientState;
    /** `controlsFolded`: too narrow for every control beside the title (useAdaptiveHeader). */
    collapse?: { usageCollapsed: boolean; titleCollapsed: boolean; controlsFolded?: boolean };
}): React.ReactElement {
    const conversation = client.selectedConversation();
    const controlsFolded = collapse.controlsFolded === true;
    const title = conversation ? displayTitle(conversation) : "Conversation";
    const status = state.sessionStatus;
    const runState = conversation?.session_state;
    const limits = status?.limits?.filter((limit) => limit.label.trim());
    const meters = buildUsageMeters(status, limits, state.hostVitals);
    const shortModel = status?.model ? shortModelName(status.model) : undefined;
    const hasSubtitle = Boolean(status?.model || status?.email || runState);
    const browserQueued = useMemo(
        () =>
            conversation?.agent_kind !== "codex" &&
            browserToolsState(state.events, runState === "running", status?.extras) === "queued",
        [conversation?.agent_kind, state.events, runState, status?.extras],
    );
    // The mission chip's data: fetched whenever another conversation comes on screen (mission
    // markers keep it fresh after that), and only ever shown for the conversation it was fetched for.
    const convoId = conversation?.id;
    useEffect(() => {
        if (convoId) void client.loadConversationMissions(convoId);
    }, [client, convoId]);
    const missionLinks =
        convoId && state.conversationMissions?.convoId === convoId ? state.conversationMissions.links : [];
    return (
        <HeaderShell
            mode="parent"
            onBack={() => client.clearSelection()}
            backLabel="Back to conversations"
            title={title}
            titleNode={conversation ? <TaggedTitle conversation={conversation} agents={state.agents} /> : undefined}
            subtitle={
                <>
                    {status?.model && <span className="mj_HeaderModel">{modelLine(status.model, status.effort)}</span>}
                    <LimitsResetIndicator limits={limits} />
                    {/* The account the session runs under, after its workdir, as on the Mac. */}
                    {status?.email && <span className="mj_HeaderEmail">{status.email}</span>}
                    {runState && <span className={`mj_HeaderState mj_HeaderState_${runState}`}>{runState}</span>}
                </>
            }
            subtitleCompact={
                (shortModel || runState) && (
                    <span className="mj_HeaderMetaCompact">
                        {runState && (
                            <span className={`mj_HeaderStatusDot mj_HeaderStatusDot_${runState}`} aria-hidden="true" />
                        )}
                        {runState && <span className="mj_SrOnly">{runState}</span>}
                        {shortModel && <span className="mj_HeaderModelShort">{shortModel}</span>}
                    </span>
                )
            }
            hasSubtitle={hasSubtitle}
            titleAccessory={
                conversation && missionLinks.length > 0 ? (
                    <MissionChip client={client} conversation={conversation} links={missionLinks} />
                ) : undefined
            }
            rightControls={
                status?.context && (
                    <CompactButton client={client} contextTokens={status.context.tokens} iconOnly={controlsFolded} />
                )
            }
            persistentControls={
                // Keyed by conversation id so a selection change while the menu is open
                // remounts (and closes) it, instead of silently retargeting the actions.
                conversation && (
                    <>
                        {browserQueued && (
                            <span className="mj_HeaderChip" role="status">
                                <span className="mj_Spinner" aria-hidden="true" />
                                Restarting after this step
                            </span>
                        )}
                        {!controlsFolded && (
                            <RoomsControl
                                key={`rooms-${conversation.id}`}
                                client={client}
                                state={state}
                                conversation={conversation}
                            />
                        )}
                        <MediaBrowserButton
                            key={`media:${conversation.id}`}
                            client={client}
                            convoId={conversation.id}
                        />
                        <ChatTasksButton client={client} state={state} convoId={conversation.id} />
                        <ConvoNotifyBell
                            key={`notify-${conversation.id}`}
                            client={client}
                            convoId={conversation.id}
                            onlyWhenSilenced={controlsFolded}
                        />
                        <HeaderOverflowMenu
                            key={conversation.id}
                            client={client}
                            conversation={conversation}
                            state={state}
                            extras={
                                controlsFolded
                                    ? (pick) => (
                                          <OverflowRoomsAndNotify
                                              client={client}
                                              state={state}
                                              conversation={conversation}
                                              onPick={pick}
                                          />
                                      )
                                    : undefined
                            }
                        />
                    </>
                )
            }
            hideControlsWhenCompact
            limits={meters}
            collapse={collapse}
        />
    );
}

// Opens the conversation's Media / Files / Links browser. Keyed by conversation, so moving to
// another chat closes it.
function MediaBrowserButton({ client, convoId }: { client: MatronJournalClient; convoId: string }): React.ReactElement {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    // A Files row: the chat's own file chip, so a file opens the same way it does in the chat.
    const renderFile = useCallback(
        (item: MediaItem): React.ReactNode =>
            item.expired ? (
                <ExpiredFile filename={item.filename} contentType={item.contentType} />
            ) : (
                <AuthenticatedMedia
                    client={client}
                    mediaId={item.mediaId}
                    image={false}
                    filename={item.filename || "attachment"}
                    contentType={item.contentType}
                    size={item.size}
                />
            ),
        [client],
    );
    return (
        <>
            <button
                type="button"
                className="mj_IconButton mj_MediaBrowserToggle"
                aria-label="Media, files and links"
                aria-haspopup="dialog"
                title="Media, files & links"
                onClick={() => setOpen(true)}
            >
                <MediaBrowserIcon aria-hidden />
            </button>
            {open &&
                createPortal(
                    <MediaBrowserSheet client={client} convoId={convoId} renderFile={renderFile} onClose={close} />,
                    document.body,
                )}
        </>
    );
}

// Opens the Tasks & decisions pane beside the chat. Its badge counts this chat's open items that
// wait on the user, from the app-wide open items that already feed the For you badge.
function ChatTasksButton({
    client,
    state,
    convoId,
}: {
    client: MatronJournalClient;
    state: ClientState;
    convoId: string;
}): React.ReactElement {
    const needsYou = useMemo(
        () => (state.inboxItems ?? []).filter((item) => item.origin_convo_id === convoId && needsUser(item)).length,
        [state.inboxItems, convoId],
    );
    // Pressed only while the slot beside the chat shows the Tasks pane (a subagent there wins).
    const open = chatSidePane(state)?.kind === "tasks";
    return (
        <button
            type="button"
            className={`mj_IconButton mj_ChatTasksToggle${open ? " mj_ChatTasksToggle_open" : ""}`}
            aria-label={`Tasks and decisions${needsYou > 0 ? `, ${needsYou} need you` : ""}`}
            aria-pressed={open}
            title="Tasks & decisions"
            onClick={() => client.toggleChatTasks(!open)}
        >
            <ChecklistIcon aria-hidden />
            <NeedsYouBadge count={needsYou} />
        </button>
    );
}

function SubChatHeader({
    client,
    state,
    collapse = { usageCollapsed: false, titleCollapsed: false },
}: {
    client: MatronJournalClient;
    state: ClientState;
    collapse?: { usageCollapsed: boolean; titleCollapsed: boolean };
}): React.ReactElement {
    const selected = client.selectedConversation();
    const status = state.sessionStatus;
    const limits = status?.limits?.filter((limit) => limit.label.trim());
    const meters = buildUsageMeters(status, limits, state.hostVitals);
    const runState = selected?.session_state;
    const running = runState === "running";
    const shortModel = status?.model ? shortModelName(status.model) : undefined;
    // §10.11: the header names the CHILD (title), the parent is named in the subtitle
    // (hierarchy, read-only) and again on the back chip (actionable escape) — never in the
    // title while the chip offers to return there.
    const parent =
        selected?.parent_convo_id != null
            ? state.conversations.find((conversation) => conversation.id === selected.parent_convo_id)
            : undefined;
    const runLabel = running ? "working" : runState || "idle";
    const goBack = (): void => {
        if (!selected) {
            client.clearSelection();
            return;
        }
        const parentId = selected.parent_convo_id;
        if (
            parentId &&
            parentId !== selected.id &&
            state.conversations.some((conversation) => conversation.id === parentId)
        ) {
            void client.selectConversation(parentId);
        } else {
            client.clearSelection();
        }
    };

    return (
        <HeaderShell
            mode="child"
            onBack={goBack}
            backLabel="Back to parent"
            title={selected ? displayTitle(selected) : "Subagent"}
            titleNode={selected ? <TaggedTitle conversation={selected} agents={state.agents} /> : undefined}
            titleGlyph="↳"
            titleBadge={<span className="mj_HeaderSubagentBadge">subagent</span>}
            subtitle={
                <>
                    {parent && (
                        <span className="mj_HeaderParentRef">
                            of <span className="mj_HeaderParentName">{displayTitle(parent)}</span>
                        </span>
                    )}
                    {runState && <span className={`mj_HeaderState mj_HeaderState_${runState}`}>{runLabel}</span>}
                </>
            }
            subtitleCompact={
                <span className="mj_HeaderMetaCompact">
                    <span
                        className={`mj_HeaderStatusDot mj_HeaderStatusDot_${running ? "running" : "idle"}`}
                        aria-hidden="true"
                    />
                    <span className="mj_SrOnly">{running ? "Running" : "Finished"}</span>
                    {shortModel && <span className="mj_HeaderModelShort">{shortModel}</span>}
                </span>
            }
            hasSubtitle
            limits={meters}
            collapse={collapse}
        />
    );
}

function ReadOnlyHint(): React.ReactElement {
    return <div className="mj_ReadOnlyHint">Read-only — subagent transcript</div>;
}

export function QueuedReleaseCard({
    client,
    event,
    isReadOnly = false,
    resolvedAction,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    isReadOnly?: boolean;
    resolvedAction?: (itemId: string) => "send" | "cancel" | "expired" | undefined;
}): React.ReactElement {
    const items = (Array.isArray(event.payload.items) ? event.payload.items : []).flatMap((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const record = item as EventPayload;
        const text = asString(record.text);
        return text ? [{ id: asString(record.id), text }] : [];
    });
    const actions = (Array.isArray(event.payload.actions) ? event.payload.actions : []).flatMap((action) => {
        if (typeof action !== "object" || action === null || Array.isArray(action)) return [];
        const record = action as EventPayload;
        const id = asString(record.id);
        if (!id) return [];
        return [{ id, label: asString(record.label, id), intent: asString(record.intent, "neutral") }];
    });
    const declaredPrimaryIndex = actions.findIndex((action) => action.intent === "primary");
    const primaryIndex = declaredPrimaryIndex >= 0 ? declaredPrimaryIndex : actions.length > 0 ? 0 : -1;
    const resolution = items.map((item) => resolvedAction?.(item.id)).find((action) => action !== undefined);
    const [phase, setPhase] = useState<"idle" | "sending" | "resolved">(resolution === undefined ? "idle" : "resolved");
    const phaseRef = useRef(phase);
    const watchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const clearWatchdog = useCallback((): void => {
        if (watchdogRef.current === undefined) return;
        clearTimeout(watchdogRef.current);
        watchdogRef.current = undefined;
    }, []);
    const sendAction = (action: string): void => {
        if ((action !== "send" && action !== "cancel") || phaseRef.current !== "idle") return;

        phaseRef.current = "sending";
        if (!client.sendPromptReply(event.seq, action)) {
            phaseRef.current = "idle";
            return;
        }

        setPhase("sending");
        watchdogRef.current = setTimeout(() => {
            watchdogRef.current = undefined;
            if (phaseRef.current !== "sending") return;
            phaseRef.current = "idle";
            setPhase("idle");
            console.warn("matron: queued-release reply timed out", {
                event: "queued_release_reply_timeout",
                target_seq: event.seq,
            });
        }, 10_000);
    };

    useEffect(() => {
        if (resolution === undefined) return;
        clearWatchdog();
        phaseRef.current = "resolved";
        setPhase("resolved");
    }, [clearWatchdog, resolution]);

    useEffect(() => clearWatchdog, [clearWatchdog]);

    return (
        <div className="mj_PromptCard mj_QueuedReleaseCard">
            <div className="mj_PromptHeader">
                <span className="mj_PromptLabel">Queued message</span>
                <time className="mj_PromptTime" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </div>
            <div className="mj_PromptBody">
                <span className="mj_PromptGlyph" aria-hidden="true">
                    <PromptMailGlyph />
                </span>
                {items.length > 0 ? (
                    <div>
                        {items.map((item, index) => (
                            <span
                                key={`${item.id}:${index}`}
                                className="mj_PromptQuestion"
                                style={{
                                    display: "-webkit-box",
                                    WebkitBoxOrient: "vertical",
                                    WebkitLineClamp: 3,
                                    overflow: "hidden",
                                }}
                            >
                                {item.text}
                            </span>
                        ))}
                    </div>
                ) : (
                    <span className="mj_PromptQuestion">{asString(event.payload.body)}</span>
                )}
            </div>
            {!isReadOnly && resolution === undefined && actions.length > 0 && (
                <div className="mj_PromptOptions">
                    {actions.map((action, index) => {
                        const variant = index === primaryIndex ? "primary" : "neutral";
                        return (
                            <button
                                key={`${action.id}:${index}`}
                                type="button"
                                className={variant === "primary" ? "mj_PromptOption_affirmative" : undefined}
                                data-intent={action.intent}
                                data-variant={variant}
                                value={action.id}
                                disabled={phase !== "idle"}
                                onClick={() => sendAction(action.id)}
                            >
                                {action.label}
                            </button>
                        );
                    })}
                </div>
            )}
            {resolution !== undefined && resolution !== "expired" && (
                <div className="mj_PromptResolved">
                    <span className="mj_PromptGlyph mj_PromptGlyph_ok" aria-hidden="true">
                        <PromptCheckGlyph />
                    </span>
                    <span className="mj_Answered">{resolution === "send" ? "Sent" : "Cancelled"}</span>
                </div>
            )}
            {resolution === "expired" && (
                // Terminal abandoned state: the bridge has
                // authoritatively expired this card (restart/crash abandoned the
                // live queue). Both buttons are already removed (gated on
                // `resolution === undefined` above); render a muted terminal
                // note distinct from the Sent/Cancelled resolution.
                <div className="mj_PromptResolved mj_PromptResolved_expired">
                    <span className="mj_Answered mj_Expired">Expired — no longer actionable</span>
                </div>
            )}
        </div>
    );
}

function PromptCard({
    client,
    event,
    answered,
    answeredChoice,
    permission = false,
    isReadOnly = false,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answered: boolean;
    answeredChoice?: string;
    permission?: boolean;
    isReadOnly?: boolean;
}): React.ReactElement {
    const [freeText, setFreeText] = useState("");
    // Indexes of the options ticked on a pick_many question; nothing is sent until Send.
    const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
    const questionId = useId();
    const [locallyAnswered, setLocallyAnswered] = useState(false);
    const [confirmationTimedOut, setConfirmationTimedOut] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const question = permission
        ? asString(event.payload.description, "Permission request")
        : asString(event.payload.question, "The agent needs your input");
    const rawOptions = Array.isArray(event.payload.options)
        ? event.payload.options
        : permission
          ? ["Allow", "Deny"]
          : [];
    const options = rawOptions.map((option) => {
        if (typeof option === "string") return { label: option, value: option };
        if (typeof option === "object" && option) {
            const record = option as EventPayload;
            const label = asString(record.label, asString(record.value, asString(record.id, "Option")));
            return { label, value: asString(record.value, asString(record.id, label)) };
        }
        return { label: String(option), value: String(option) };
    });
    // A multi-select question (`mode: "pick_many"`): options toggle, and one Send answers with
    // every ticked option's value, in option order, joined by ", " — the reply the other apps send.
    const pickMany = !permission && event.payload.mode === "pick_many" && options.length > 0;
    const resolved = answered || (!permission && locallyAnswered);
    const expiresAt =
        typeof event.payload.expires_at === "number" && Number.isFinite(event.payload.expires_at)
            ? event.payload.expires_at
            : undefined;
    // Client expiry is advisory because browser and bridge clocks can differ; the bridge's
    // own timer and durable prompt_reply remain the canonical authorization decision.
    const advisoryExpired = permission && !resolved && expiresAt !== undefined && nowMs >= expiresAt;
    const pending = permission && locallyAnswered && !resolved && !confirmationTimedOut;
    const retryable = permission && locallyAnswered && !resolved && confirmationTimedOut;
    const disabled = resolved || pending;
    const answer = (choice?: string, text?: string): void => {
        if (disabled) return;
        if (client.sendPromptReply(event.seq, choice, text)) {
            setLocallyAnswered(true);
            setConfirmationTimedOut(false);
        }
    };
    const normalizedAnsweredChoice = answeredChoice?.trim().toLocaleLowerCase();
    const durablyDenied = permission && resolved && normalizedAnsweredChoice === "deny";
    const durablyAllowed = permission && resolved && !durablyDenied;

    useEffect(() => {
        if (!permission || resolved || expiresAt === undefined || advisoryExpired) return;

        const updateNow = (): void => setNowMs(Date.now());
        const msLeft = expiresAt - Date.now();
        if (msLeft <= 0) {
            updateNow();
            return;
        }

        const timer = setTimeout(updateNow, Math.min(msLeft, MAX_TIMEOUT_MS));
        return (): void => clearTimeout(timer);
    }, [permission, resolved, expiresAt, advisoryExpired, nowMs]);

    useEffect(() => {
        if (!pending) return;

        const timer = setTimeout(() => setConfirmationTimedOut(true), PROMPT_REPLY_CONFIRMATION_TIMEOUT_MS);
        return (): void => clearTimeout(timer);
    }, [pending]);

    // §10.5 one primary per surface: exactly one filled affirmative. For permission it's
    // "Allow"; for a generic question the first option whose label reads affirmative
    // (send/yes/continue/confirm/ok/approve). Chosen by SEMANTICS, not position, so a
    // reordered payload never fills "Always allow" / "Deny" / "Cancel".
    // A multi-select question's one primary is its Send button, never an option.
    const affirmativeIndex = pickMany
        ? -1
        : options.findIndex((option) =>
              permission
                  ? option.label.trim().toLocaleLowerCase() === "allow"
                  : PROMPT_AFFIRMATIVE.test(option.label.trim()),
          );
    const togglePicked = (index: number): void =>
        setPicked((current) => {
            const next = new Set(current);
            if (!next.delete(index)) next.add(index);
            return next;
        });
    const sendPicked = (): void => {
        const values = options.filter((_option, index) => picked.has(index)).map((option) => option.value);
        if (values.length > 0) answer(values.join(", "));
    };

    return (
        <div className={permission ? "mj_PromptCard mj_PromptCard_permission" : "mj_PromptCard"}>
            <div className="mj_PromptHeader">
                <span className="mj_PromptLabel">{permission ? "Permission request" : "Question"}</span>
                <time className="mj_PromptTime" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </div>
            <div className="mj_PromptBody">
                <span className="mj_PromptGlyph" aria-hidden="true">
                    {permission ? <PromptTerminalGlyph /> : <PromptMailGlyph />}
                </span>
                <span className="mj_PromptQuestion" id={questionId}>
                    {question}
                </span>
            </div>
            {!isReadOnly && !resolved && pickMany && (
                <>
                    <div
                        className="mj_PromptOptions mj_PromptOptions_pickMany"
                        role="group"
                        aria-labelledby={questionId}
                    >
                        {options.map((option, index) => (
                            <button
                                key={`${option.label}:${option.value}`}
                                type="button"
                                className="mj_PromptOption_toggle"
                                aria-pressed={picked.has(index)}
                                disabled={pending}
                                onClick={() => togglePicked(index)}
                            >
                                <span className="mj_PromptOption_check" aria-hidden="true">
                                    {picked.has(index) && <PromptCheckGlyph />}
                                </span>
                                {option.label}
                            </button>
                        ))}
                    </div>
                    <div className="mj_PromptOptions mj_PromptOptions_send">
                        <button
                            type="button"
                            className="mj_PromptOption_affirmative"
                            disabled={pending || picked.size === 0}
                            onClick={sendPicked}
                        >
                            Send
                        </button>
                    </div>
                </>
            )}
            {!isReadOnly && !resolved && !pickMany && options.length > 0 && (
                <div className="mj_PromptOptions">
                    {options.map((option, index) => (
                        <button
                            key={`${option.label}:${option.value}`}
                            className={index === affirmativeIndex ? "mj_PromptOption_affirmative" : undefined}
                            disabled={pending}
                            onClick={() => answer(option.value)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
            {!isReadOnly && !disabled && (event.payload.allows_free_text === true || options.length === 0) && (
                <form
                    className="mj_PromptText"
                    onSubmit={(submitEvent) => {
                        submitEvent.preventDefault();
                        if (freeText.trim()) answer(undefined, freeText.trim());
                    }}
                >
                    <input
                        value={freeText}
                        onChange={(changeEvent) => setFreeText(changeEvent.target.value)}
                        placeholder="Type an answer"
                    />
                    <button type="submit" className="mj_PromptOption_affirmative" disabled={!freeText.trim()}>
                        Send
                    </button>
                </form>
            )}
            {pending && (
                <div className="mj_PromptResolved mj_PromptResolved_pending">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">Sending…</span>
                </div>
            )}
            {retryable && (
                <div className="mj_PromptResolved mj_PromptResolved_retryable">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">Reply not confirmed — tap to retry</span>
                </div>
            )}
            {resolved && (
                <div
                    className={`mj_PromptResolved${durablyAllowed ? " mj_PromptResolved_allowed" : ""}${durablyDenied ? " mj_PromptResolved_denied" : ""}`}
                >
                    <span
                        className="mj_PromptGlyph mj_PromptGlyph_ok"
                        aria-hidden="true"
                        style={
                            durablyDenied
                                ? { color: "var(--mj-color-text-critical-primary)" }
                                : durablyAllowed
                                  ? { color: "var(--mj-color-usage-low)" }
                                  : undefined
                        }
                    >
                        {durablyDenied ? <PromptDeniedGlyph /> : <PromptCheckGlyph />}
                    </span>
                    <span
                        className="mj_Answered"
                        style={
                            durablyDenied
                                ? { color: "var(--mj-color-text-critical-primary)" }
                                : durablyAllowed
                                  ? { color: "var(--mj-color-usage-low)" }
                                  : undefined
                        }
                    >
                        {durablyDenied ? "Denied" : durablyAllowed ? "Allowed" : "Answered"}
                    </span>
                </div>
            )}
            {advisoryExpired && (
                <div className="mj_PromptResolved mj_PromptResolved_expired">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Expired">May have expired</span>
                </div>
            )}
        </div>
    );
}

// §10.2 alignment grid: SVG glyphs in the 24px prompt-card gutter (never inline emoji,
// which make the text's left edge a function of glyph width). Stroke inherits currentColor.
const PROMPT_AFFIRMATIVE = /^(send|yes|continue|confirm|ok|okay|approve|proceed|accept)\b/i;

function PromptMailGlyph(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4 6h16v12H4z" />
            <path d="m4 7 8 6 8-6" />
        </svg>
    );
}

function PromptCheckGlyph(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m5 12 4 4 10-10" />
        </svg>
    );
}

function PromptDeniedGlyph(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
        >
            <path d="m6 6 12 12M18 6 6 18" />
        </svg>
    );
}

type AgentChatLocalPhase = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

type AgentChatAnswerOutcome =
    { kind: "settled"; answer: RememberedAgentChatAnswer } | { kind: "failed"; message: string };

// Answers still in flight, keyed by answers scope + card. Module-level so they outlive the card:
// the request is never aborted on unmount, and a remounted card follows it instead of drawing
// its buttons again (a second tap would race the first, and its 409 read as "expired").
const agentChatAnswersInFlight = new Map<string, Promise<AgentChatAnswerOutcome>>();

const noopAgentChatAnswer = (_decision: AgentChatDecision): Promise<unknown> => Promise.resolve();

// A transport failure surfaces as a JournalApiError with status 0.
function agentChatErrorMessage(error: unknown): string {
    if (error instanceof JournalApiError && error.status === 404) return "That request is no longer on the server.";
    if (error instanceof JournalApiError && error.status !== 0) return "The server refused that answer.";
    return "Couldn't reach the server — check your connection and try again.";
}

function rememberedResolution(answer: RememberedAgentChatAnswer | undefined): AgentChatResolution | undefined {
    if (answer === undefined) return undefined;
    return answer === "expired" ? { kind: "expired" } : { kind: "answered", approved: answer === "approve" };
}

// The agent-chat consent card: who is asking to talk to whom, about what and why, and the two
// buttons that answer it. Same .mj_PromptCard chrome as the spawn card. Unlike the spawn card
// there is no durable outcome event to wait for: a 200 from the answer call IS the decision, so
// it is remembered locally. Precedence: what the timeline says (the consent item's closing
// marker — a decision made on another device, or the ask lapsing) > the answer remembered here
// > the in-flight/failed tap > answerable. A 409 means the ask stopped waiting between drawing
// and the tap; that is nothing the user can act on, so it settles the card rather than erroring.
// An answer in flight is never aborted when the card unmounts (leaving the conversation): the
// decision may already be on the server, and it is still remembered when the call settles.
function AgentChatRequestCard({
    event,
    request,
    resolution,
    coordinatorDecision,
    answersScope,
    isReadOnly = false,
    onAnswer = noopAgentChatAnswer,
}: {
    event: JournalEvent;
    request: AgentChatRequest;
    resolution?: AgentChatResolution;
    /** The Coordinator's answer to this card, when it gave one: it settles the card, and its
        reason goes on the outcome line. */
    coordinatorDecision?: CoordinatorDecision;
    /** Where this session's answers are remembered (agentChatAnswersScope). */
    answersScope?: string;
    isReadOnly?: boolean;
    onAnswer?: (decision: AgentChatDecision) => Promise<unknown>;
}): React.ReactElement {
    const cardKey = agentChatCardKey(event);
    const flightKey = `${answersScope ?? ""}|${cardKey}`;
    const [remembered, setRemembered] = useState(() => rememberedAgentChatAnswer(answersScope, cardKey));
    // A card remounted while its answer is still in flight (the user left the conversation and
    // came back) picks the request up again rather than offering the buttons a second time.
    const [phase, setPhase] = useState<AgentChatLocalPhase>(() =>
        agentChatAnswersInFlight.has(flightKey) ? { kind: "sending" } : { kind: "idle" },
    );
    const mountedRef = useRef(false);

    const follow = useCallback((flight: Promise<AgentChatAnswerOutcome>): void => {
        void flight.then((outcome) => {
            if (!mountedRef.current) return;
            if (outcome.kind === "failed") {
                setPhase({ kind: "failed", message: outcome.message });
            } else {
                setRemembered(outcome.answer);
                setPhase({ kind: "idle" });
            }
        });
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        const flight = agentChatAnswersInFlight.get(flightKey);
        if (flight) follow(flight);
        return (): void => {
            mountedRef.current = false;
        };
    }, [flightKey, follow]);

    // A Coordinator decision outranks everything: a later close of its consent item cannot undo it.
    const settled: AgentChatResolution | undefined = coordinatorDecision
        ? { kind: "answered", approved: coordinatorDecision.approved, byCoordinator: true }
        : (resolution ?? rememberedResolution(remembered));

    const handleAnswer = (decision: AgentChatDecision): void => {
        if (settled || agentChatAnswersInFlight.has(flightKey)) return;
        setPhase({ kind: "sending" });
        const flight = onAnswer(decision)
            .then(
                (): AgentChatAnswerOutcome => ({ kind: "settled", answer: decision }),
                (error: unknown): AgentChatAnswerOutcome =>
                    error instanceof JournalApiError && error.status === 409
                        ? { kind: "settled", answer: "expired" }
                        : { kind: "failed", message: agentChatErrorMessage(error) },
            )
            .then((outcome): AgentChatAnswerOutcome => {
                agentChatAnswersInFlight.delete(flightKey);
                if (outcome.kind === "settled") {
                    rememberAgentChatAnswer(answersScope, cardKey, outcome.answer);
                    // A 409 never overwrites a decision already remembered for this card.
                    const stored = rememberedAgentChatAnswer(answersScope, cardKey);
                    return stored ? { kind: "settled", answer: stored } : outcome;
                }
                return outcome;
            });
        agentChatAnswersInFlight.set(flightKey, flight);
        follow(flight);
    };

    const sending = !settled && phase.kind === "sending";
    const fields: Array<[string, string, string]> = [
        ["from", "From", agentChatFromLabel(request)],
        ["to", "To", agentChatToLabel(request)],
    ];
    if (request.topic) fields.push(["about", "About", request.topic]);
    if (request.justification) fields.push(["why", "Why", request.justification]);

    return (
        <div className="mj_PromptCard mj_PromptCard_chat">
            <div className="mj_PromptHeader">
                <span className="mj_PromptLabel">Agent chat request</span>
                <time className="mj_PromptTime" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </div>
            <div className="mj_PromptBody">
                <span className="mj_PromptGlyph" aria-hidden="true">
                    <PromptPeopleGlyph />
                </span>
                <span className="mj_PromptQuestion">{agentChatHeadline(request)}</span>
            </div>
            <div className="mj_SpawnDetails">
                {fields.map(([key, label, value]) => (
                    <div key={key} className={`mj_SpawnDetail mj_ChatDetail_${key}`}>
                        <span className="mj_SpawnDetail_label">{label}</span>
                        <span className="mj_SpawnDetail_value">{value}</span>
                    </div>
                ))}
            </div>
            {!isReadOnly && !settled && (
                <div className="mj_PromptOptions">
                    <button type="button" disabled={sending} onClick={() => handleAnswer("deny")}>
                        Decline
                    </button>
                    <button
                        type="button"
                        className="mj_PromptOption_affirmative"
                        disabled={sending}
                        onClick={() => handleAnswer("approve")}
                    >
                        Approve
                    </button>
                </div>
            )}
            {sending && (
                <div className="mj_PromptResolved mj_PromptResolved_pending">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">Sending…</span>
                </div>
            )}
            {!settled && phase.kind === "failed" && (
                <div className="mj_PromptResolved mj_PromptResolved_failed" role="alert">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Answered" style={{ color: "var(--mj-color-text-critical-primary)" }}>
                        {phase.message}
                    </span>
                </div>
            )}
            {settled?.kind === "answered" && (
                <div
                    className={`mj_PromptResolved ${settled.approved ? "mj_PromptResolved_allowed" : "mj_PromptResolved_denied"}`}
                >
                    <span
                        className="mj_PromptGlyph mj_PromptGlyph_ok"
                        aria-hidden="true"
                        style={{
                            color: settled.approved ? "var(--mj-color-usage-low)" : "var(--mj-color-text-secondary)",
                        }}
                    >
                        {settled.approved ? <PromptCheckGlyph /> : <PromptDeniedGlyph />}
                    </span>
                    <span className="mj_Answered">{agentChatOutcomeText(settled, coordinatorDecision)}</span>
                </div>
            )}
            {settled?.kind === "expired" && (
                <div className="mj_PromptResolved mj_PromptResolved_expired">
                    <span className="mj_PromptGlyph" aria-hidden="true" />
                    <span className="mj_Muted">This request is no longer waiting for an answer.</span>
                </div>
            )}
        </div>
    );
}

function agentChatOutcomeText(
    settled: Extract<AgentChatResolution, { kind: "answered" }>,
    coordinatorDecision: CoordinatorDecision | undefined,
): string {
    if (coordinatorDecision) return coordinatorBadgeText(coordinatorDecision);
    if (settled.byCoordinator) return settled.approved ? "Approved by the Coordinator" : "Declined by the Coordinator";
    return settled.approved ? "Approved" : "Declined";
}

function PromptPeopleGlyph(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="9" cy="8" r="3" />
            <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
            <path d="M16 5.5a3 3 0 0 1 0 5" />
            <path d="M17.5 14a5.5 5.5 0 0 1 3 5" />
        </svg>
    );
}

// Minimal standalone row for the durable spawn_outcome event itself (§ design "Timeline
// rendering of spawn_outcome itself") — keeps the record legible once the card has scrolled
// away, and stops the default case's raw JSON <details> dump.
function SpawnOutcomeRow({ client, event }: { client: MatronJournalClient; event: JournalEvent }): React.ReactElement {
    const kind = spawnOutcomeKind(event.payload);
    const roomId = asString(event.payload.room_id);
    // Surface C (design 2026-08): read as a STRUCTURAL event, not a normal message — a coloured
    // kind-rail + an uppercase "Subagent" eyebrow + the child's worker mark when known. The
    // emoji-prefixed snippet stays as the accessible row text (byte-exact with the server).
    // Worker kind is derived from the CHILD conversation (where agent_kind actually lands via
    // convo_meta), not from the spawn_outcome payload — that contract carries no agent_kind, so
    // reading it there would render no mark for every real event.
    const childId = asString(event.payload.child_convo_id) || roomId;
    const childConversation = childId
        ? client.getSnapshot().conversations.find((conversation) => conversation.id === childId)
        : undefined;
    const childKind = childConversation ? workerKind(childConversation) : null;
    const workerMark = markForKind(childKind, "mj_SpawnOutcomeRow_kindMark");
    const eyebrow = childKind === "claude" || childKind === "codex" ? `Subagent · ${childKind}` : "Subagent";
    return (
        <div className={`mj_SpawnOutcomeRow mj_SpawnOutcomeRow_${kind}`}>
            <span className="mj_SpawnOutcomeRow_rail" aria-hidden />
            {workerMark}
            <div className="mj_SpawnOutcomeRow_text">
                <span className="mj_SpawnOutcomeRow_eyebrow">{eyebrow}</span>
                <span className="mj_SpawnOutcomeStatus">{spawnOutcomeSnippet(event.payload)}</span>
            </div>
            {kind === "started" && roomId && (
                <button
                    type="button"
                    className="mj_Btn mj_Btn_primary mj_SpawnOpenButton"
                    onClick={() => void client.selectConversation(roomId, { suppressNotFound: true })}
                >
                    Open
                </button>
            )}
        </div>
    );
}

/** A tagged bridge notice: icon, summary and time on one line; the full text when opened. */
function SystemNoticeRow({
    client,
    event,
    notice,
    body,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    notice: SystemNotice;
    body: string;
}): React.ReactElement {
    return (
        <details className="mj_SystemNotice" data-notice-kind={notice.kind}>
            <summary title={notice.summary}>
                <ChevronDownIcon className="mj_SystemNotice_chevron" aria-hidden="true" />
                <span className="mj_SystemNotice_icon" aria-hidden="true">
                    {notice.icon}
                </span>
                <span className="mj_SystemNotice_summary">{notice.summary}</span>
                <time className="mj_SystemNotice_time" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </summary>
            <div className="mj_SystemNotice_body mj_Markdown">
                <MarkdownBody
                    text={body}
                    label={String(event.seq)}
                    onTrackerLink={(kind, num) => client.openTrackerLink(kind, num)}
                />
            </div>
        </details>
    );
}

function ToolOutput({
    client,
    event,
    defaultOpen = false,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    /** Deep detail inside the turn card opens the card expanded. */
    defaultOpen?: boolean;
}): React.ReactElement {
    const payload = event.payload;
    const command = asString(payload.command).trim() || asString(payload.tool_name).trim() || "Tool output";
    const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : undefined;
    const failed = payload.denied === true || (exitCode !== undefined && exitCode !== 0);
    const expired = payload.expired === true;
    // Mac ToolCallCard: the command's first token bold, its arguments smaller and grey, one line.
    const [commandName, ...commandRest] = command === "Tool output" ? [command] : command.split(/\s+/);
    const commandArgs = commandRest.join(" ");
    const outcome =
        payload.denied === true ? "denied" : exitCode !== undefined ? `exit ${exitCode}` : failed ? "failed" : "done";
    const blobRef = typeof payload.blob_ref === "string" ? payload.blob_ref : undefined;
    const [fullOutput, setFullOutput] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();

    const load = async (): Promise<void> => {
        if (!blobRef || loading) return;
        setLoading(true);
        setError(undefined);
        try {
            const url = await client.mediaUrl(blobRef);
            const response = await fetch(url);
            setFullOutput(await response.text());
        } catch (loadError) {
            setError(errorMessage(loadError));
        } finally {
            setLoading(false);
        }
    };

    return (
        <details className={`mj_ToolCard ${failed ? "mj_ToolCard_failed" : ""}`} open={defaultOpen || undefined}>
            <summary title={command} aria-label={`${command}, ${failed ? `failed, ${outcome}` : outcome}`}>
                <ChevronDownIcon className="mj_ToolCard_chevron" aria-hidden="true" />
                {/* Mac: a green check or a red octagon says how it went; no exit badge, no time here. */}
                <span
                    className={`mj_ToolCard_status mj_ToolCard_status_${failed ? "failed" : "ok"}`}
                    aria-hidden="true"
                >
                    {failed ? <XOctagonIcon /> : <CheckCircleIcon />}
                </span>
                <code className="mj_ToolCard_command">
                    <b className="mj_ToolCard_cmd">{commandName}</b>
                    {commandArgs && <span className="mj_ToolCard_args"> {commandArgs}</span>}
                </code>
            </summary>
            <div className="mj_ToolCard_meta">
                {outcome} · <time dateTime={new Date(event.ts).toISOString()}>{formatTime(event.ts)}</time>
            </div>
            <div className="mj_ToolCommand">
                <code>{command}</code>
            </div>
            {expired ? (
                <div className="mj_Expired">Output expired after 24 hours.</div>
            ) : (
                <>
                    {(fullOutput ?? asString(payload.snippet)) && <pre>{fullOutput ?? asString(payload.snippet)}</pre>}
                    {blobRef && fullOutput === undefined && (
                        <button className="mj_TextButton" onClick={() => void load()} disabled={loading}>
                            {loading ? "Loading…" : "Load full output"}
                        </button>
                    )}
                    {payload.truncated === true && <div className="mj_Muted">Preview truncated</div>}
                    {error && <div className="mj_Error">{error}</div>}
                </>
            )}
        </details>
    );
}

// §6: pick a file-tile glyph from the coarse MIME bucket. Generic sheet is the fallback.
const FILE_KIND_ICON: Record<FileKind, (props: React.SVGProps<SVGSVGElement>) => React.ReactElement> = {
    image: ImageFileIcon,
    pdf: PdfFileIcon,
    text: TextFileIcon,
    audio: AudioFileIcon,
    video: VideoFileIcon,
    archive: ArchiveFileIcon,
    generic: FileIcon,
};

// An image the server's media reaper has deleted: say so instead of a forever-loading frame or
// a fetch error. Reached from the payload tombstone (`expired: true`) or a 404 on fetch.
function ExpiredImage({ caption }: { caption?: string }): React.ReactElement {
    return (
        <figure className="mj_Image">
            <div
                className="mj_MediaExpired"
                role="img"
                aria-label={caption ? `Image attachment, expired. ${caption}` : "Image attachment, expired"}
            >
                <ImageFileIcon className="mj_FileIcon" aria-hidden />
                <span>Image expired</span>
            </div>
            {caption && <figcaption>{caption}</figcaption>}
        </figure>
    );
}

// The file counterpart: the name stays readable, the size gives way to "Expired", and there is
// no click target — there is nothing left to download.
function ExpiredFile({ filename, contentType }: { filename?: string; contentType?: string }): React.ReactElement {
    const KindIcon = FILE_KIND_ICON[fileKindFromMime(contentType)];
    const name = filename || "attachment";
    return (
        <span className="mj_File mj_File_expired" role="group" aria-label={`File attachment: ${name}, expired`}>
            <KindIcon className="mj_FileIcon" aria-hidden />
            <span className="mj_FileName">{name}</span>
            <span className="mj_Expired">Expired</span>
        </span>
    );
}

// Voice notes and other short clips load into the player once their row scrolls into view, like
// the viewer's thumbnails; past this size the player waits for a click so a long recording is not
// downloaded just by scrolling past. Opening a conversation full of voice notes therefore fetches
// only the ones on screen, not every clip in the history.
const AUDIO_AUTOLOAD_MAX_BYTES = 20 * 1024 * 1024;

function InlineAudio({
    client,
    mediaId,
    filename,
    contentType,
    size,
}: {
    client: MatronJournalClient;
    mediaId: string;
    filename?: string;
    contentType?: string;
    size?: number;
}): React.ReactElement {
    const autoload = size !== undefined && size <= AUDIO_AUTOLOAD_MAX_BYTES;
    // `clicked` asks for playback once the blob is in; `inView` only loads it.
    const [clicked, setClicked] = useState(false);
    const [inView, setInView] = useState(false);
    const holderRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!autoload || inView) return undefined;
        const holder = holderRef.current;
        if (!holder) return undefined;
        if (typeof IntersectionObserver === "undefined") {
            setInView(true); // jsdom / old engines: degrade to eager
            return undefined;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setInView(true);
                observer.disconnect();
            }
        });
        observer.observe(holder);
        return () => observer.disconnect();
    }, [autoload, inView]);
    const name = filename || "audio";
    const sizeLabel = formatBytes(size);
    if (!clicked && !(autoload && inView)) {
        return (
            <button ref={holderRef} className="mj_File" onClick={() => setClicked(true)} aria-label={`Play ${name}`}>
                <AudioFileIcon className="mj_FileIcon" />
                <span className="mj_FileName">{name}</span>
                {sizeLabel && <span className="mj_FileSize">{sizeLabel}</span>}
            </button>
        );
    }
    return (
        <InlineAudioPlayer
            client={client}
            mediaId={mediaId}
            filename={filename}
            contentType={contentType}
            sizeLabel={sizeLabel}
            autoPlay={clicked}
        />
    );
}

function InlineAudioPlayer({
    client,
    mediaId,
    filename,
    contentType,
    sizeLabel,
    autoPlay,
}: {
    client: MatronJournalClient;
    mediaId: string;
    filename?: string;
    contentType?: string;
    sizeLabel?: string;
    autoPlay: boolean;
}): React.ReactElement {
    // Same authenticated blob as every other attachment, re-typed so an octet-stream blob still
    // plays.
    const { url, error, expired, retry } = useRenderableObjectUrl(client, {
        mediaId,
        kind: "audio",
        filename,
        contentType,
    });
    const audioRef = useRef<HTMLAudioElement>(null);
    // A click on Play starts playback once the blob arrives. The fetch outlives the click's
    // user-activation window, so a browser with a strict autoplay policy may refuse: the player
    // is on screen with its own controls by then, so a refusal just leaves it paused.
    useEffect(() => {
        if (!autoPlay || !url) return;
        const played = audioRef.current?.play();
        played?.catch(() => undefined);
    }, [autoPlay, url]);
    if (expired) return <ExpiredFile filename={filename} contentType={contentType} />;
    const name = filename || "audio";
    if (error) {
        // A transient failure (a 404 is `expired` above): keep the row and offer another try.
        return (
            <div className="mj_Audio">
                <div className="mj_Audio_head">
                    <AudioFileIcon className="mj_FileIcon" aria-hidden />
                    <span className="mj_FileName">{name}</span>
                </div>
                <div className="mj_Error">
                    {error}{" "}
                    <button
                        type="button"
                        className="mj_Audio_retry"
                        onClick={retry}
                        aria-label={`Retry loading ${name}`}
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="mj_Audio">
            <div className="mj_Audio_head">
                <AudioFileIcon className="mj_FileIcon" aria-hidden />
                <span className="mj_FileName">{name}</span>
                {sizeLabel && <span className="mj_FileSize">{sizeLabel}</span>}
            </div>
            {url ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <audio
                    ref={audioRef}
                    className="mj_Audio_player"
                    src={url}
                    controls
                    preload="metadata"
                    aria-label={`Play ${name}`}
                />
            ) : (
                <div className="mj_MediaLoading">Loading audio…</div>
            )}
        </div>
    );
}

function AuthenticatedMedia({
    client,
    mediaId,
    image,
    filename,
    caption,
    dims,
    contentType,
    size,
}: {
    client: MatronJournalClient;
    mediaId: string;
    image: boolean;
    filename?: string;
    caption?: string;
    dims?: MediaDims;
    contentType?: string;
    size?: number;
}): React.ReactElement {
    const [url, setUrl] = useState<string>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);
    // A 404 means the blob was reaped server-side — permanent, so it renders as expired rather
    // than as an error. Seeded from the client so a remounted row does not ask again.
    const [expired, setExpired] = useState(() => client.isMediaExpired(mediaId));
    const viewer = useMediaViewer();
    const markdownPreview = useMarkdownPreview();

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            setUrl(await client.mediaUrl(mediaId));
        } catch (loadError) {
            if (isMediaExpiredError(loadError)) setExpired(true);
            else setError(errorMessage(loadError));
        } finally {
            setLoading(false);
        }
    }, [client, mediaId]);

    useEffect(() => {
        if (image && !expired) void load();
    }, [image, expired, load]);

    if (expired) {
        return image ? (
            <ExpiredImage caption={caption} />
        ) : (
            <ExpiredFile filename={filename} contentType={contentType} />
        );
    }
    if (error) return <div className="mj_Error">{error}</div>;
    if (image) {
        // Reserve an aspect-ratio box BEFORE the blob decodes so the thread does not reflow when
        // the image finishes loading. imageFrameStyle pre-shrinks the width so the CSS max-height
        // cap preserves the aspect ratio (a non-replaced <div> won't back-shrink on its own).
        // Absent dims means no reserved box, current fluid behaviour (fallback for un-measured).
        const frameStyle: React.CSSProperties | undefined = dims ? imageFrameStyle(dims) : undefined;
        // Emit the JS-authoritative height cap as a CSS custom property so the pcss frame rules
        // (`.mj_ImageFrame_sized`, `.mj_Image img`) consume it via var() and cannot drift from the
        // JS constant. Set on the always-present figure so it cascades to both sized and fluid cases.
        const figureStyle = { "--mj-image-frame-max-height": `${IMAGE_FRAME_MAX_HEIGHT_PX}px` } as React.CSSProperties;
        return (
            <figure className="mj_Image" style={figureStyle}>
                <div
                    className={`mj_ImageFrame${dims ? " mj_ImageFrame_sized" : ""}`}
                    style={frameStyle}
                    data-dims={dims ? `${dims.width}x${dims.height}` : undefined}
                >
                    {url ? (
                        <img
                            src={url}
                            alt={caption || "Shared image"}
                            className={viewer ? "mj_Image_zoomable" : undefined}
                            role={viewer ? "button" : undefined}
                            tabIndex={viewer ? 0 : undefined}
                            aria-label={viewer ? `Open image${caption ? `, ${caption}` : ""}` : undefined}
                            onClick={viewer ? (event) => viewer.openViewer(mediaId, event.currentTarget) : undefined}
                            onKeyDown={
                                viewer
                                    ? (event) => {
                                          if (event.key === "Enter" || event.key === " ") {
                                              event.preventDefault();
                                              viewer.openViewer(mediaId, event.currentTarget);
                                          }
                                      }
                                    : undefined
                            }
                            onError={() => setError("Image failed to load")}
                        />
                    ) : (
                        <div className="mj_MediaLoading">{loading ? "Loading image…" : "Image"}</div>
                    )}
                </div>
                {caption && <figcaption>{caption}</figcaption>}
            </figure>
        );
    }
    if (mediaRenderKind(false, contentType, filename) === "audio") {
        return (
            <InlineAudio client={client} mediaId={mediaId} filename={filename} contentType={contentType} size={size} />
        );
    }
    const sizeLabel = formatBytes(size);
    const sizeTag = sizeLabel && <span className="mj_FileSize">{sizeLabel}</span>;
    const KindIcon = FILE_KIND_ICON[fileKindFromMime(contentType)];
    const fileLabel = filename || "Download attachment";
    // Markdown up to 2 MB opens in the side preview panel (which offers Download); larger files
    // keep the download chip.
    if (markdownPreview && isPreviewableMarkdown({ mime: contentType, name: filename, size })) {
        return (
            <>
                <button
                    className="mj_File mj_File_preview"
                    onClick={() =>
                        markdownPreview.openMarkdownPreview({
                            blobRef: mediaId,
                            name: filename || "attachment.md",
                            size,
                        })
                    }
                    aria-label={`Preview ${fileLabel}`}
                >
                    <KindIcon className="mj_FileIcon" />
                    <span className="mj_FileName">{fileLabel}</span>
                </button>
                {sizeTag}
            </>
        );
    }
    // Renderable files (svg / pdf / video / raster) open the lightbox inline; the viewer
    // fetches the blob itself and offers Download. Non-renderable types keep the plain
    // download chip (HTML and unknown never render inline).
    if (viewer && isRenderableInViewer(contentType, filename)) {
        return (
            <>
                <button
                    className="mj_File mj_File_preview"
                    onClick={(event) => viewer.openViewer(mediaId, event.currentTarget)}
                    aria-label={`Preview ${fileLabel}`}
                >
                    <KindIcon className="mj_FileIcon" />
                    <span className="mj_FileName">{fileLabel}</span>
                </button>
                {sizeTag}
            </>
        );
    }
    return (
        <>
            {url ? (
                <a className="mj_File" href={url} download={filename || "attachment"}>
                    <KindIcon className="mj_FileIcon" />
                    <span className="mj_FileName">{fileLabel}</span>
                </a>
            ) : (
                <button className="mj_File" onClick={() => void load()} disabled={loading}>
                    <KindIcon className="mj_FileIcon" />
                    <span className="mj_FileName">{loading ? "Preparing download…" : fileLabel}</span>
                </button>
            )}
            {sizeTag}
        </>
    );
}

export interface DiffCardData {
    diff: string;
    displayPath?: string;
    filePath?: string;
    viewerUrl?: string;
    viewerUrlExp?: number; // unix seconds from token payload; undefined if unreadable
    tool?: string;
    label?: string;
    added?: number;
    removed?: number;
    truncated: boolean;
    newFile: boolean;
}

// Module-level, once per page load: distinguishes "bridge withheld a link"
// (no token param at all → expected, silent) from "a token was present but
// undecodable" (schema drift → a signal worth one console warning). Throttled
// to one warn per session so a fleet-wide token-format change is visible in a
// console without spamming N cards. See M3 / P3 (fail-visible).
let _viewerExpDecodeWarned = false;

// A legitimate bridge token is base64url(JSON{path,exp,workdir}) + '.' + sig. Its
// worst case is NOT tiny: generateFileLink embeds two full absolute paths, so with
// both near PATH_MAX the encoded token approaches ~11KB. 16384 covers that with
// margin while still bounding pathological (multi-MB) input far below any DoS size.
// The bound is applied to the RAW viewerUrl string FIRST — before new URL() — so an
// oversized durable event is rejected pre-parse (P8 Guard Boundary Inputs). Note the
// residual: parseDiffPayload's own new URL(payload.viewer_url) at components.tsx:1305
// already parses the full string before this
// runs, so this bound protects only the work THIS function adds, not that prior parse.
const MAX_VIEWER_TOKEN_LEN = 16384;

function decodeViewerExp(viewerUrl: string): number | undefined {
    if (viewerUrl.length > MAX_VIEWER_TOKEN_LEN) return undefined; // bound raw input BEFORE any parse (silent; not a schema-drift signal)
    let token: string | null = null;
    try {
        // Defensive re-parse: in the real integration path parseDiffPayload already
        // validated this exact string with new URL() (components.tsx:1301-1309), so
        // this catch is unreachable via that caller — it future-proofs a direct call.
        token = new URL(viewerUrl).searchParams.get("token");
    } catch {
        return undefined; // malformed URL — not a token-schema signal, stay silent
    }
    if (!token) return undefined; // no token param → nothing to decode (silent)
    try {
        const payload = token.split(".")[0];
        if (!payload) throw new Error("empty token payload");
        const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
        // Range-sanity: require a POSITIVE, *1000-SAFE INTEGER exp. Integer is
        // load-bearing (not cosmetic): the render compares floor(Date.now()/1000)
        // to exp+grace, so a fractional exp (K+0.2) could leave the floored clock
        // forever below the threshold while the timer's msLeft<=0 branch writes the
        // same floored value — no state change, no re-arm, link wedged live. The
        // exp*1000 ceiling matters too: a huge-but-"integer" value (1e308 passes
        // Number.isInteger; 9e15 is a non-safe integer) makes exp*1000 lose
        // precision or become Infinity, so the clamp re-arms forever and the link
        // stays live — the exact failure this feature removes. The bridge always
        // mints a small floored-seconds exp (Math.floor(...) at index.js:343), so
        // these bounds match the producer and are defense-in-depth against a forged
        // durable event. MAX_EXP = floor(MAX_SAFE_INTEGER / 1000) keeps exp*1000 exact.
        const MAX_EXP = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
        if (!Number.isSafeInteger(json.exp) || json.exp <= 0 || json.exp > MAX_EXP) {
            throw new Error("no valid in-range integer exp");
        }
        return json.exp;
    } catch (err) {
        // A token WAS present but did not decode to a valid exp → schema-drift
        // signal. Warn once; still return undefined (degrade to live-link).
        if (!_viewerExpDecodeWarned) {
            _viewerExpDecodeWarned = true;
            console.warn(
                "DiffCard: viewer_url token present but exp undecodable — expiry detection disabled for this token shape",
                err,
            );
        }
        return undefined;
    }
}

export function parseDiffPayload(payload: EventPayload): DiffCardData {
    let viewerUrl: string | undefined;
    if (typeof payload.viewer_url === "string" && payload.viewer_url) {
        try {
            const url = new URL(payload.viewer_url);
            viewerUrl = url.protocol === "https:" ? payload.viewer_url : undefined;
        } catch {
            viewerUrl = undefined;
        }
    }
    // NOTE: the oversized-token bound lives ONLY inside decodeViewerExp (below),
    // not on this link-render guard. An oversized-but-valid viewer_url must still
    // render as a live link (viewer stays authoritative) — it just skips expiry
    // detection. Gating the link itself on length regressed valid long links to
    // no-link (Codex phase-1 review). The viewer_url string is already received +
    // JSON-parsed by the journal client before this runs, so the pre-existing
    // new URL() above is not a fresh unbounded-allocation DoS surface.

    return {
        diff: asString(payload.diff, asString(payload.patch, JSON.stringify(payload, null, 2))),
        displayPath:
            typeof payload.display_path === "string" && payload.display_path ? payload.display_path : undefined,
        filePath: typeof payload.file_path === "string" && payload.file_path ? payload.file_path : undefined,
        viewerUrl,
        viewerUrlExp: viewerUrl ? decodeViewerExp(viewerUrl) : undefined,
        tool: typeof payload.tool === "string" && payload.tool ? payload.tool : undefined,
        label: typeof payload.label === "string" && payload.label ? payload.label : undefined,
        added: typeof payload.added === "number" ? payload.added : undefined,
        removed: typeof payload.removed === "number" ? payload.removed : undefined,
        truncated: payload.truncated === true,
        newFile: payload.new_file === true,
    };
}

const MAX_DIFF_LINES = 5000;
const CLOCK_SKEW_GRACE_SEC = 30;
const MAX_TIMEOUT_MS = 2_147_483_647;

export function DiffCard({ data }: { data: DiffCardData }): React.ReactElement {
    const [expanded, setExpanded] = useState(false);
    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
    const expiresAt = data.viewerUrlExp;
    const expired = expiresAt !== undefined && nowSec >= expiresAt + CLOCK_SKEW_GRACE_SEC;
    const allLines = data.diff.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    const overflowed = allLines.length > MAX_DIFF_LINES;
    const lines = overflowed ? allLines.slice(0, MAX_DIFF_LINES) : allLines;
    const lineCount = lines.length;
    const expandable = lineCount > 12;
    const path = data.displayPath ?? data.filePath ?? "file";
    const filename = path.split(/[\\/]/).at(-1) || "file";
    const visibleLines = expanded ? lines : lines.slice(0, 12);

    useEffect(() => {
        if (expiresAt === undefined || expired) return;

        const bump = (): void => setNowSec(Math.floor(Date.now() / 1000));
        const msLeft = (expiresAt + CLOCK_SKEW_GRACE_SEC) * 1000 - Date.now();
        if (msLeft <= 0) {
            bump();
            return;
        }

        const timer = setTimeout(bump, Math.min(msLeft + 500, MAX_TIMEOUT_MS));
        return (): void => clearTimeout(timer);
    }, [expiresAt, expired, nowSec]);

    const toggleExpanded = (): void => setExpanded((current) => !current);
    const lineClass = (line: string): string => {
        if (line.startsWith("+")) return "mj_DiffLine_add";
        if (line.startsWith("-")) return "mj_DiffLine_del";
        if (line.startsWith("@")) return "mj_DiffLine_hunk";
        return "mj_DiffLine_ctx";
    };

    return (
        <div className="mj_DiffCard">
            <div className="mj_DiffCard_header">
                {expandable && (
                    <button
                        type="button"
                        className="mj_DiffCard_chevron"
                        aria-expanded={expanded}
                        aria-label={expanded ? "Collapse diff" : "Expand diff"}
                        onClick={toggleExpanded}
                    >
                        <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
                            <path
                                d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"}
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </button>
                )}
                <FileEditIcon aria-hidden="true" />
                {data.viewerUrl && !expired ? (
                    <a
                        className="mj_DiffCard_filename mj_DiffCard_link"
                        href={data.viewerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {filename}
                    </a>
                ) : data.viewerUrl && expired ? (
                    <>
                        <span
                            className="mj_DiffCard_filename mj_DiffCard_expired"
                            title="Viewer link expired — re-open the file from a fresh edit"
                        >
                            {filename}
                        </span>
                        <span className="mj_DiffCard_expiredNote">link expired</span>
                    </>
                ) : (
                    <span className="mj_DiffCard_filename">{filename}</span>
                )}
                {data.label && <span className="mj_DiffCard_label">{data.label}</span>}
                {data.newFile && <span className="mj_DiffCard_badge">new file</span>}
                {typeof data.added === "number" && <span className="mj_DiffCard_added">+{data.added}</span>}
                {typeof data.removed === "number" && <span className="mj_DiffCard_removed">−{data.removed}</span>}
                {data.truncated && <span title="diff truncated">…</span>}
            </div>
            <div className="mj_DiffCard_body">
                <div className="mj_DiffCard_track">
                    {visibleLines.map((line, index) => (
                        <div className={lineClass(line)} key={`${index}:${line}`}>
                            {line}
                        </div>
                    ))}
                </div>
                {expandable && !expanded && (
                    <button type="button" className="mj_DiffCard_more" onClick={toggleExpanded}>
                        +{lineCount - 12} more lines
                    </button>
                )}
                {overflowed && expanded && (
                    <div className="mj_DiffCard_truncated">… diff too large; showing first {MAX_DIFF_LINES} lines</div>
                )}
                {data.truncated && <div className="mj_DiffCard_truncated">… diff truncated</div>}
            </div>
        </div>
    );
}

function isLegacyQueuePrompt(event: JournalEvent): boolean {
    if (event.type !== "prompt" || asString(event.payload.kind) === "queued_release") return false;
    if (!Array.isArray(event.payload.options)) return false;
    return event.payload.options.some((option) => {
        if (typeof option !== "object" || option === null || Array.isArray(option)) return false;
        const payload = option as EventPayload;
        const id = asString(payload.id);
        const value = asString(payload.value);
        return (id === "cancel" && /^cancel:\d+$/.test(value)) || (id === "interrupt" && value === "interrupt");
    });
}

// New queue-card tap echoes are identified by the queued prompt they target.
// Legacy tiles also need a legacy control choice: an ordinary prompt may
// coincidentally contain one legacy-shaped option while receiving a real
// answer through another option. Bridge-authored release events are control
// records too, so none of these control shapes renders as a chat bubble.
export function isQueuedReleaseReply(
    event: JournalEvent,
    queuedReleasePromptSeqs: ReadonlySet<number>,
    legacyQueuePromptSeqs: ReadonlySet<number>,
): boolean {
    if (event.type !== "prompt_reply") return false;
    if (asString(event.payload.kind) === "queued_release") return true;
    const targetSeq = asNumber(event.payload.target_seq, Number.NaN);
    if (queuedReleasePromptSeqs.has(targetSeq)) return true;
    const choice = asString(event.payload.choice);
    return legacyQueuePromptSeqs.has(targetSeq) && (choice === "interrupt" || /^cancel:\d+$/.test(choice));
}

/**
 * Tracker events that EventContent renders as null and so must not occupy a timeline row at all —
 * otherwise EventRow still wraps the null content in an avatar + sender bubble (a ghost message).
 * Two families: the plain-text `fallback_for` mirror the bridge emits for old clients (this client
 * renders the real `item` marker instead), and every `item` marker that renders no card — the quiet
 * invalidation-only reordered/updated AND any unknown action under version skew. The item test
 * delegates to the SAME classifier renderItemMarker uses (isRenderableItemMarker), so rendering and
 * suppression can never diverge and an unsupported action can never leave a ghost row (F5).
 */
function isSuppressedTrackerEvent(event: JournalEvent): boolean {
    if (event.type === "text") return asString(event.payload.fallback_for).length > 0;
    if (event.type === "item") return !isRenderableItemMarker(event);
    return false;
}

function PeerMessage({ event }: { event: JournalEvent }): React.ReactElement {
    const rawFromKind = asString(event.payload.from_kind);
    const fromKind = rawFromKind === "claude" || rawFromKind === "codex" ? rawFromKind : null;
    const fromName = sanitizePeerText(event.payload.from_name, PEER_NAME_CAP) || "peer agent";
    const body = sanitizePeerText(event.payload.body, PEER_BODY_CAP);
    // Priority is a net-new, not-yet-produced payload key — read defensively so
    // the louder variant lights up the moment a producer sets it, and stays dormant until then.
    const priority = event.payload.priority === true || asString(event.payload.priority) === "true";
    const mark = markForKind(fromKind, "mj_PeerMessage_mark");

    // Surface B (design 2026-08): a durable left-edged card — worker mark, session name, and a
    // muted `peer` tag — reads as "another AI is speaking into your thread" without masquerading
    // as your own (right, teal) or the primary agent (left, no card). The full header (name +
    // priority badge) always renders; from_convo-aware continuation grouping is a follow-up (see
    // journal.pcss note — the timeline's sender-only continuation predicate would misattribute).
    return (
        <div
            className={`mj_PeerMessage${priority ? " mj_PeerMessage_priority" : ""}`}
            aria-label={fromKind === null ? `Peer agent from ${fromName}` : `Peer message from ${fromName}`}
        >
            <div className="mj_PeerMessage_head">
                {mark ?? <InactiveIcon className="mj_PeerMessage_mark mj_PeerMessage_mark_neutral" />}
                <span className="mj_PeerMessage_name">
                    <bdi>{fromName}</bdi>
                </span>
                {priority ? (
                    <span className="mj_PeerMessage_priorityBadge">Priority</span>
                ) : (
                    <span className="mj_PeerMessage_tag">{fromKind === null ? "peer agent" : "peer"}</span>
                )}
            </div>
            <div className="mj_PeerMessage_body">
                <bdi>{body}</bdi>
            </div>
        </div>
    );
}

const EMPTY_SPAWN_OUTCOMES: ReadonlyMap<string, EventPayload> = new Map();
const EMPTY_AGENT_CHAT_RESOLUTIONS: ReadonlyMap<string, AgentChatResolution> = new Map();
const EMPTY_COORDINATOR_DECISIONS: ReadonlyMap<string, CoordinatorDecision> = new Map();

// A permission-decision reply is a prompt_reply targeting a permission_request
// card. The card already renders the decision inline (answered/allowed/denied
// via answeredPromptReplies), so its reply must NOT also render as a standalone
// chat bubble — that duplicate reads as if the operator typed "Allow"/"Deny"
// into the thread. Identified by target-seq provenance, mirroring
// isQueuedReleaseReply: prompt_reply carries no self-identifying kind, so a
// permission reply is only distinguishable by the permission_request it targets.
const TRANSCRIPT_HIDDEN_TYPES = new Set(["read_marker", "edit", "session_status", "convo_meta", "summary"]);

/** Whether the transcript leaves `event` out: bookkeeping frames, and rows folded into another
 *  (answered queue releases, decided permissions, restated item cards). One rule for the chat and
 *  the subagent pane beside it. */
function isFoldedTranscriptEvent(
    event: JournalEvent,
    folds: {
        queuedReleasePromptSeqs: ReadonlySet<number>;
        legacyQueuePromptSeqs: ReadonlySet<number>;
        permissionRequestSeqs: ReadonlySet<number>;
        itemCards: { hidden: ReadonlySet<number> };
    },
): boolean {
    return (
        TRANSCRIPT_HIDDEN_TYPES.has(event.type) ||
        isUnrenderableNoticeEvent(event) ||
        isQueuedReleaseReply(event, folds.queuedReleasePromptSeqs, folds.legacyQueuePromptSeqs) ||
        isSuppressedTrackerEvent(event) ||
        (event.type === "item" && folds.itemCards.hidden.has(event.seq)) ||
        isPermissionDecisionReply(event, folds.permissionRequestSeqs)
    );
}

export function isPermissionDecisionReply(event: JournalEvent, permissionRequestSeqs: ReadonlySet<number>): boolean {
    if (event.type !== "prompt_reply") return false;
    const targetSeq = asNumber(event.payload.target_seq, Number.NaN);
    return permissionRequestSeqs.has(targetSeq);
}

export function EventContent({
    client,
    event,
    answeredPromptReplies,
    spawnOutcomes = EMPTY_SPAWN_OUTCOMES,
    agentChatResolutions = EMPTY_AGENT_CHAT_RESOLUTIONS,
    coordinatorDecisions = EMPTY_COORDINATOR_DECISIONS,
    itemCards = EMPTY_ITEM_CARD_FOLD,
    isReadOnly = false,
    resolvedAction,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPromptReplies: ReadonlyMap<string, { choice?: string }>;
    spawnOutcomes?: ReadonlyMap<string, EventPayload>;
    agentChatResolutions?: ReadonlyMap<string, AgentChatResolution>;
    /** The Coordinator's answers, keyed by card (readCoordinatorDecisions). */
    coordinatorDecisions?: ReadonlyMap<string, CoordinatorDecision>;
    itemCards?: ItemCardFold;
    isReadOnly?: boolean;
    resolvedAction?: (itemId: string) => "send" | "cancel" | "expired" | undefined;
}): React.ReactElement | null {
    const answer = answeredPromptReplies.get(`${event.convo_id}:${event.seq}`);
    switch (event.type) {
        case "text": {
            // A tracker fallback text (payload.fallback_for set) is the plain-text mirror the
            // bridge emits for old clients that can't render the real `item` marker. This client
            // renders that marker, so suppress the duplicate fallback text.
            if (asString(event.payload.fallback_for)) return null;
            const body = asString(event.payload.body);
            // A bridge notice about a turn it injected (payload.notice): one short row, the full
            // text one click away.
            const notice = systemNotice(event);
            if (notice) return <SystemNoticeRow client={client} event={event} notice={notice} body={body} />;
            // A bridge "🔀 Subtask: …" line opens the subagent it started, once that is known.
            const subtask = event.sender.startsWith("user:") ? undefined : subtaskDescription(body);
            if (subtask) {
                return (
                    <SubtaskLine client={client} convoId={event.convo_id} description={subtask}>
                        <div className="mj_Markdown">
                            <MarkdownBody text={body} label={String(event.seq)} />
                        </div>
                    </SubtaskLine>
                );
            }
            return (
                <div className="mj_Markdown">
                    {/* A Coordinator briefing (payload.briefing_id) is an ordinary text event in the
                        Coordinator conversation; a small badge says what it is. */}
                    {asString(event.payload.briefing_id) ? <span className="mj_BriefingBadge">Briefing</span> : null}
                    <MarkdownBody
                        text={body}
                        label={String(event.seq)}
                        onTrackerLink={(kind, num) => client.openTrackerLink(kind, num)}
                    />
                </div>
            );
        }
        case "item": {
            // Quiet invalidation-only markers (reordered/updated) and unknown actions render null. An
            // item card shows its item's latest state (foldItemCards), not this marker's frozen one.
            const restated = itemCards.restated.get(event.seq);
            return renderItemMarker(restated ? { ...event, payload: restated } : event, client);
        }
        case "milestone":
            return <MilestoneCard client={client} event={event} />;
        case "mission":
            return <MissionNotice client={client} event={event} />;
        case "peer_message":
            return <PeerMessage event={event} />;
        case "memory":
            return <MemoryNotice client={client} event={event} />;
        case "coordinator":
        case "routine":
        case "consent_decision":
            return <CoordinatorEventNotice event={event} />;
        case "prompt":
            if (asString(event.payload.kind) === "queued_release") {
                return (
                    <QueuedReleaseCard
                        client={client}
                        event={event}
                        isReadOnly={isReadOnly}
                        resolvedAction={resolvedAction}
                    />
                );
            }
            return (
                <PromptCard
                    key={`${event.convo_id}:${event.seq}`}
                    client={client}
                    event={event}
                    answered={answer !== undefined}
                    answeredChoice={answer?.choice}
                    isReadOnly={isReadOnly}
                />
            );
        case "permission_request": {
            if (isAgentChatPayload(event.payload)) {
                const request = parseAgentChatRequest(event.payload);
                // A malformed agent-chat payload can't be answered: the generic PromptCard's
                // Allow/Deny would post a prompt_reply nothing reads. Draw an inert notice instead.
                if (!request) {
                    return <div className="mj_AgentRequestNotice">{unanswerableAgentRequestNotice(event.payload)}</div>;
                }
                return (
                    <AgentChatRequestCard
                        key={`${event.convo_id}:${event.seq}`}
                        event={event}
                        request={request}
                        resolution={agentChatResolutions.get(agentChatCardKey(event))}
                        coordinatorDecision={coordinatorDecisions.get(agentChatCardKey(event))}
                        answersScope={agentChatAnswersScope(client.getSnapshot().session)}
                        isReadOnly={isReadOnly}
                        onAnswer={(decision) =>
                            client.answerAgentChat(request.roomId, request.targetDeviceId, decision)
                        }
                    />
                );
            }
            if (asString(event.payload.kind) === "agent_spawn") {
                const requestId = asString(event.payload.request_id);
                // A malformed agent_spawn payload (no request_id/task) can never be resolved:
                // the generic PromptCard's Allow/Deny post through sendPromptReply, a channel the
                // bridge doesn't listen on for spawns — the buttons would be dead. Render the
                // spawn card read-only instead so the request is visible but not tappable.
                const answerable = isAnswerableAgentSpawn(event.payload);
                return (
                    <AgentSpawnCard
                        key={`${event.convo_id}:${event.seq}`}
                        event={event}
                        outcome={(requestId ? spawnOutcomes.get(requestId) : undefined) ?? null}
                        coordinatorDecision={coordinatorDecisions.get(agentChatCardKey(event))}
                        isReadOnly={isReadOnly || !answerable}
                        onAnswer={
                            answerable
                                ? (decision, signal) => client.answerAgentSpawn(requestId, decision, signal)
                                : undefined
                        }
                        onOpen={(roomId) => void client.selectConversation(roomId, { suppressNotFound: true })}
                        onStopSession={(convoId) =>
                            void stopSpawnedSession(convoId, (target) => client.sendMessage("/stop", target))
                        }
                    />
                );
            }
            return (
                <PromptCard
                    key={`${event.convo_id}:${event.seq}`}
                    client={client}
                    event={event}
                    answered={answer !== undefined}
                    answeredChoice={answer?.choice}
                    permission
                    isReadOnly={isReadOnly}
                />
            );
        }
        case "prompt_reply":
            return (
                <div className="mj_MessageText">
                    {asString(event.payload.choice, asString(event.payload.text, "Answered"))}
                </div>
            );
        case "spawn_outcome":
            return <SpawnOutcomeRow client={client} event={event} />;
        case "tool_output":
            return <ToolOutput client={client} event={event} />;
        case "diff":
            return <DiffCard data={parseDiffPayload(event.payload)} />;
        case "image": {
            const mediaId = asString(event.payload.blob_ref);
            if (event.payload.expired === true) return <ExpiredImage caption={asString(event.payload.caption)} />;
            return mediaId ? (
                <AuthenticatedMedia
                    client={client}
                    mediaId={mediaId}
                    image
                    caption={asString(event.payload.caption)}
                    dims={parseMediaDims(event.payload.dims)}
                    contentType={asString(event.payload.content_type) || undefined}
                />
            ) : (
                <div className="mj_Muted">Image unavailable</div>
            );
        }
        case "file": {
            const mediaId = asString(event.payload.blob_ref);
            const expired = event.payload.expired === true;
            return (
                <div>
                    {expired ? (
                        <ExpiredFile
                            filename={mediaFileName(event.payload) || undefined}
                            contentType={asString(event.payload.content_type) || undefined}
                        />
                    ) : mediaId ? (
                        <AuthenticatedMedia
                            client={client}
                            mediaId={mediaId}
                            image={false}
                            filename={mediaFileName(event.payload) || "attachment"}
                            contentType={asString(event.payload.content_type) || undefined}
                            size={
                                typeof event.payload.size === "number" && Number.isFinite(event.payload.size)
                                    ? event.payload.size
                                    : undefined
                            }
                        />
                    ) : (
                        <>
                            <span className="mj_Muted">File unavailable</span>
                            {formatBytes(event.payload.size) && (
                                <span className="mj_FileSize">{formatBytes(event.payload.size)}</span>
                            )}
                        </>
                    )}
                    {asString(event.payload.caption) && (
                        <div className="mj_FileCaption">{asString(event.payload.caption)}</div>
                    )}
                </div>
            );
        }
        default:
            return (
                <details className="mj_Unknown">
                    <summary>{event.type}</summary>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </details>
            );
    }
}

function EventRow({
    client,
    event,
    answeredPromptReplies,
    spawnOutcomes,
    agentChatResolutions,
    coordinatorDecisions,
    itemCards,
    isReadOnly = false,
    resolvedAction,
    continuation = false,
    lastInSection = true,
    searchHighlighted = false,
    rowHandlers,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPromptReplies: ReadonlyMap<string, { choice?: string }>;
    spawnOutcomes?: ReadonlyMap<string, EventPayload>;
    agentChatResolutions?: ReadonlyMap<string, AgentChatResolution>;
    coordinatorDecisions?: ReadonlyMap<string, CoordinatorDecision>;
    itemCards?: ItemCardFold;
    isReadOnly?: boolean;
    resolvedAction: (itemId: string) => "send" | "cancel" | "expired" | undefined;
    continuation?: boolean;
    lastInSection?: boolean;
    searchHighlighted?: boolean;
    rowHandlers: RowContextMenu<JournalEvent>["rowHandlers"];
}): React.ReactElement {
    const peer = event.type === "peer_message";
    // A bridge notice row is its own one-line row: no sender header, no grouping, never an own bubble.
    const noticeRow = isSystemNoticeEvent(event);
    const own = !peer && !noticeRow && event.sender.startsWith("user:");
    const liRef = useRef<HTMLLIElement>(null);
    const handlers = rowHandlers(event, () => liRef.current);
    return (
        <li
            ref={liRef}
            className={`mj_EventTile${peer ? " mj_EventTile_peer" : ""}${continuation ? " mj_EventTile_continuation" : ""}${lastInSection ? " mj_EventTile_lastInSection" : ""}${noticeRow ? " mj_EventTile_systemNotice" : ""}${searchHighlighted ? " mj_EventRow_searchHighlighted" : ""}`}
            style={
                peer
                    ? {
                          borderInlineStart: "3px solid var(--cpd-color-text-action-accent)",
                          paddingInlineStart: "var(--cpd-space-3x)",
                      }
                    : undefined
            }
            tabIndex={-1}
            aria-live="polite"
            aria-atomic="true"
            data-layout="bubble"
            data-self={own}
            data-event-id={event.seq}
            {...handlers}
            onClickCapture={handlers.onClickCapture}
        >
            {!own && !continuation && !noticeRow && (
                <span className="mj_SenderName">
                    <MsgAvatar />
                    <span className="mj_SenderName_displayName">{displaySender(event.sender)}</span>
                    {/* tool_output owns its timestamp inline (after the exit badge); prompt /
                        permission cards own theirs in the card header (§10.2). Suppress the
                        profile-row time for all three so a first-in-section event never shows
                        two identical timestamps. */}
                    {event.type !== "tool_output" && event.type !== "prompt" && event.type !== "permission_request" && (
                        <a href={`#event-${event.seq}`} onClick={(clickEvent) => clickEvent.preventDefault()}>
                            <time className="mj_MessageTimestamp" dateTime={new Date(event.ts).toISOString()}>
                                {formatTime(event.ts)}
                            </time>
                        </a>
                    )}
                </span>
            )}
            <div className="mj_EventTile_line">
                {/* Own bubbles carry an inline timestamp (design: "…text <09:58>"). Agent
                    continuation blocks do NOT — the section shows one timestamp on the profile
                    row (§10.2 one-per-section), so continuation blocks fill to the shared right
                    edge with no reserved timestamp gutter (kills the first-block spill). */}
                {own && event.type !== "tool_output" && (
                    <a href={`#event-${event.seq}`} onClick={(clickEvent) => clickEvent.preventDefault()}>
                        <time className="mj_MessageTimestamp" dateTime={new Date(event.ts).toISOString()}>
                            {formatTime(event.ts)}
                        </time>
                    </a>
                )}
                <div className="mj_TextBody mj_EventTile_content">
                    <div className="markdown-body">
                        <EventContent
                            client={client}
                            event={event}
                            answeredPromptReplies={answeredPromptReplies}
                            spawnOutcomes={spawnOutcomes}
                            agentChatResolutions={agentChatResolutions}
                            coordinatorDecisions={coordinatorDecisions}
                            itemCards={itemCards}
                            isReadOnly={isReadOnly}
                            resolvedAction={resolvedAction}
                        />
                    </div>
                </div>
            </div>
        </li>
    );
}

/**
 * The step an activity detail names (the bridge's ephemeral "tool" activity): a Bash command
 * from Claude, or one of Codex's tool indicators. Drives the live line when no tool stream is
 * open for the running step.
 */
export function activityStep(detail: string, id = "activity"): Step | null {
    const text = detail.trim();
    if (!text) return null;
    const make = (tool: string, input: Step["input"]): Step => ({ kind: "step", id, tool, input, status: "running" });
    let match: RegExpExecArray | null;
    if ((match = /^🔧\s*`?([\s\S]*?)`?$/u.exec(text))) return make("Bash", { command: match[1] });
    if ((match = /^📖\s*(.+)$/u.exec(text))) return make("Read", { path: match[1] });
    if ((match = /^✏️?\s*(?:(?:Editing|Writing|Creating)\s+)?(.+)$/u.exec(text)))
        return make("apply_patch", { path: match[1].split(", ")[0] });
    if ((match = /^🔍\s*(.+)$/u.exec(text))) return make("Grep", { pattern: match[1] });
    if ((match = /^🌐\s*(.+)$/u.exec(text)))
        return make(/^https?:/.test(match[1]) ? "WebFetch" : "WebSearch", { url: match[1] });
    if ((match = /^🔀\s*Subtask:\s*(.+)$/u.exec(text))) return make("Task", { description: match[1] });
    if (/^\p{Extended_Pictographic}/u.test(text)) return make("tool", {});
    return make("Bash", { command: text });
}

/** First sentence of the agent's narration, trimmed to 90 characters (GENERATIVE-SYSTEM §2). */
export function narrationLiveLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    const sentence = /^(.+?[.!?…])(\s|$)/.exec(flat)?.[1] ?? flat;
    return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
}

/** Is this prompt / permission request still waiting on the operator? */
function isUnansweredAsk(
    event: JournalEvent,
    answeredPromptReplies: ReadonlyMap<string, { choice?: string }>,
    spawnOutcomes: ReadonlyMap<string, EventPayload>,
): boolean {
    if (event.type !== "prompt" && event.type !== "permission_request") return false;
    if (asString(event.payload.kind) === "queued_release") return false;
    if (answeredPromptReplies.has(`${event.convo_id}:${event.seq}`)) return false;
    if (asString(event.payload.kind) === "agent_spawn") {
        const requestId = asString(event.payload.request_id);
        return Boolean(requestId) && !spawnOutcomes.has(requestId);
    }
    return true;
}

/** A turn block that keeps the per-event row menu (Copy / View source) and search anchor. */
function TurnBlock({
    event,
    rowHandlers,
    highlighted,
    live = true,
    children,
}: {
    event: JournalEvent;
    rowHandlers: RowContextMenu<JournalEvent>["rowHandlers"];
    highlighted: boolean;
    /** Announce new content politely; off where the child is already an alert. */
    live?: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const handlers = rowHandlers(event, () => ref.current);
    return (
        <div
            ref={ref}
            className={`mj_TurnBlock${highlighted ? " mj_EventRow_searchHighlighted" : ""}`}
            data-event-id={event.seq}
            aria-live={live ? "polite" : undefined}
            aria-atomic={live ? "true" : undefined}
            {...handlers}
        >
            {children}
        </div>
    );
}

export interface TurnLive {
    mode: TurnCardMode;
    running?: Step | null;
    liveText?: string;
    runningSince?: number;
}

const NO_HELPERS: readonly Conversation[] = [];

/** A helper thread's newest turns (with steps) whose headlines open expanded. */
export const EXPANDED_HELPER_TURNS = 3;

/** Developer view: a helper's card in the flat timeline, after the event it started at. */
function DevHelperRow({ client, child }: { client: MatronJournalClient; child: Conversation }): React.ReactElement {
    return (
        <li className="mj_EventTile mj_EventTile_lastInSection mj_HelperTile" data-layout="bubble" data-self="false">
            <div className="mj_EventTile_line">
                <div className="mj_TextBody mj_EventTile_content">
                    <SubagentCard
                        child={child}
                        kind={workerKind(child)}
                        source={client}
                        onOpen={(id) => void client.selectConversation(id, { suppressNotFound: true })}
                        renderDetail={() => null}
                        renderMarkdown={(text, key) => (
                            <MarkdownBody
                                text={text}
                                label={key}
                                onTrackerLink={(kind, num) => client.openTrackerLink(kind, num)}
                            />
                        )}
                        developerView
                    />
                </div>
            </div>
        </li>
    );
}

/**
 * Deep detail of a step the bridge reported as a text line (a subagent's Read / Grep / Bash
 * indicator, a Codex generic item): its sentence, then — as for every deep detail in the v6
 * card, the one place monospace appears — the command, path or pattern it ran on.
 */
function StepSentenceDetail({ step }: { step: Step }): React.ReactElement {
    const target =
        step.input.command ||
        step.input.path ||
        step.input.pattern ||
        step.input.url ||
        // A narration line that read as machine text (headlines.ts): its text, one click deep.
        (step.id.startsWith("raw-") ? step.input.description : undefined);
    return (
        <div className="mj_TurnCard_detailText mj_StepDetail">
            <p>{stepSentence(step)}</p>
            {target && (
                <div className="mj_StepDetail_target">
                    <code>{target}</code>
                </div>
            )}
        </div>
    );
}

/**
 * One agent tile per operator turn (Show the work OFF): the turn card when the turn
 * has at least one step, then its break-throughs in the order they happened, then a
 * turn-ending error, then the answer prose.
 */
function AgentTurnRow({
    client,
    turn,
    live,
    answeredPromptReplies,
    spawnOutcomes,
    agentChatResolutions,
    coordinatorDecisions,
    itemCards,
    isReadOnly,
    resolvedAction,
    highlightedSeq,
    rowHandlers,
    helpers = NO_HELPERS,
    helperThread = null,
    expandHeadlines = false,
}: {
    client: MatronJournalClient;
    turn: Turn;
    live: TurnLive;
    /**
     * Set inside a helper's own thread (a Claude subagent or a Codex run): the steps read as a
     * list of headlines instead of one collapsed turn card. The value is the helper's worker.
     */
    helperThread?: { worker: "claude" | "codex" | null } | null;
    /** In a helper thread: open the headlines with the work in view (the newest turns). */
    expandHeadlines?: boolean;
    /** Child conversations (subagents, Codex runs) this turn started — one card each. */
    helpers?: readonly Conversation[];
    answeredPromptReplies: ReadonlyMap<string, { choice?: string }>;
    spawnOutcomes: ReadonlyMap<string, EventPayload>;
    agentChatResolutions?: ReadonlyMap<string, AgentChatResolution>;
    coordinatorDecisions?: ReadonlyMap<string, CoordinatorDecision>;
    itemCards?: ItemCardFold;
    isReadOnly: boolean;
    resolvedAction: (itemId: string) => "send" | "cancel" | "expired" | undefined;
    highlightedSeq?: number;
    rowHandlers: RowContextMenu<JournalEvent>["rowHandlers"];
}): React.ReactElement {
    const first = turn.events[0];
    const openHelper = useCallback(
        (id: string) => void client.selectConversation(id, { suppressNotFound: true }),
        [client],
    );
    const hasCard = stepsOf(turn.items).length > 0 || Boolean(live.running);
    // A reply the prompt card already shows (a picked option) is not repeated; a free-text
    // reply the card cannot show stays visible, in order among the break-throughs.
    const shownReplies = turn.replies.filter(
        (event) => !asString(event.payload.choice) && !asString(event.payload.label) && asString(event.payload.text),
    );
    const breaks = [...turn.breaks, ...shownReplies].sort((left, right) => left.seq - right.seq);
    const renderStepDetail = useCallback(
        (step: Step): React.ReactNode => {
            const source = step.source as JournalEvent | undefined;
            // A narration line the headlines took for a command (headlines.ts): its own text.
            if (!source) return step.id.startsWith("raw-") ? <StepSentenceDetail step={step} /> : null;
            if (source.type === "tool_output") return <ToolOutput client={client} event={source} defaultOpen />;
            if (source.type === "diff") return <DiffCard data={parseDiffPayload(source.payload)} />;
            return <StepSentenceDetail step={step} />;
        },
        [client],
    );
    const renderMarkdown = useCallback(
        (text: string, key: string) => (
            <MarkdownBody text={text} label={key} onTrackerLink={(kind, num) => client.openTrackerLink(kind, num)} />
        ),
        [client],
    );
    const renderDetail = useCallback(
        (step: Step): React.ReactNode => {
            // A helper step opens onto its helper: the same body as the helper's own card.
            if (step.tool === "Task" || step.tool === "Agent") {
                const helper = helperForStep(step, helpers);
                if (helper) {
                    return (
                        <SubagentCard
                            bodyOnly
                            child={helper}
                            kind={workerKind(helper)}
                            source={client}
                            onOpen={openHelper}
                            renderDetail={renderStepDetail}
                            renderMarkdown={renderMarkdown}
                            developerView={false}
                        />
                    );
                }
            }
            return renderStepDetail(step);
        },
        [client, helpers, openHelper, renderStepDetail, renderMarkdown],
    );
    const block = (event: JournalEvent): React.ReactElement => (
        <TurnBlock key={event.seq} event={event} rowHandlers={rowHandlers} highlighted={highlightedSeq === event.seq}>
            <EventContent
                client={client}
                event={event}
                answeredPromptReplies={answeredPromptReplies}
                spawnOutcomes={spawnOutcomes}
                agentChatResolutions={agentChatResolutions}
                coordinatorDecisions={coordinatorDecisions}
                itemCards={itemCards}
                isReadOnly={isReadOnly}
                resolvedAction={resolvedAction}
            />
        </TurnBlock>
    );
    // A helper's own thread: a Claude helper publishes each call when it starts, so while it runs
    // a trailing step (no answer after it) is the one running now. Codex publishes on completion.
    const headlineRunning = useMemo((): Step | null => {
        if (!helperThread || live.mode !== "running") return null;
        if (live.running) return live.running;
        const last = turn.items.at(-1);
        if (helperThread.worker === "codex" || turn.answer.length || last?.kind !== "step") return null;
        return { ...last, status: "running" };
    }, [helperThread, live.mode, live.running, turn.items, turn.answer.length]);
    const headlineItems = useMemo(
        () =>
            headlineRunning && !live.running && turn.items.at(-1)?.kind === "step"
                ? turn.items.slice(0, -1)
                : turn.items,
        [headlineRunning, live.running, turn.items],
    );
    return (
        <li
            className={`mj_EventTile mj_EventTile_lastInSection mj_AgentTurn${helperThread ? " mj_AgentTurn_helper" : ""}${
                highlightedSeq !== undefined &&
                turn.events.some((event) => event.seq === highlightedSeq) &&
                ![...turn.breaks, ...turn.answer, ...turn.errors].some((event) => event.seq === highlightedSeq)
                    ? " mj_EventRow_searchHighlighted"
                    : ""
            }`}
            tabIndex={-1}
            data-layout="bubble"
            data-self="false"
            data-turn={turn.key}
        >
            {first && (
                <span className="mj_SenderName">
                    <MsgAvatar />
                    <span className="mj_SenderName_displayName">{displaySender(first.sender)}</span>
                    <a href={`#event-${first.seq}`} onClick={(clickEvent) => clickEvent.preventDefault()}>
                        <time className="mj_MessageTimestamp" dateTime={new Date(first.ts).toISOString()}>
                            {formatTime(first.ts)}
                        </time>
                    </a>
                </span>
            )}
            <div className="mj_EventTile_line">
                <div className="mj_TextBody mj_EventTile_content">
                    <div className="markdown-body mj_AgentTurn_blocks">
                        {helperThread && (hasCard || live.mode === "running") ? (
                            <HeadlineList
                                items={headlineItems}
                                running={headlineRunning}
                                active={live.mode === "running"}
                                liveText={live.liveText}
                                runningSince={live.runningSince}
                                renderDetail={renderDetail}
                                expanded={expandHeadlines}
                                persistKey={first?.convo_id}
                                turnKey={turn.key}
                            />
                        ) : (
                            hasCard && (
                                <TurnCard
                                    turnKey={turn.key}
                                    items={turn.items}
                                    mode={live.mode}
                                    running={live.running}
                                    liveText={live.liveText}
                                    runningSince={live.runningSince}
                                    durationMs={turn.endTs - turn.startTs}
                                    renderDetail={renderDetail}
                                    renderNarration={(text) => (
                                        <MarkdownBody
                                            text={text}
                                            label={`narration-${turn.key}`}
                                            onTrackerLink={(kind, num) => client.openTrackerLink(kind, num)}
                                        />
                                    )}
                                />
                            )
                        )}
                        {/* A bridge "🔀 Subtask: …" line: upstream's card that opens the subagent beside
                            the chat once it is known, the plain line until then. The card above holds
                            the same line as a collapsed step; this is the row that opens the pane. */}
                        {!helperThread &&
                            turn.events.map((event) => {
                                if (event.type !== "text" || isOperatorEvent(event)) return null;
                                if (asString(event.payload.fallback_for)) return null;
                                const body = asString(event.payload.body);
                                const description = subtaskDescription(body);
                                if (!description) return null;
                                return (
                                    <TurnBlock
                                        key={`subtask-${event.seq}`}
                                        event={event}
                                        rowHandlers={rowHandlers}
                                        highlighted={highlightedSeq === event.seq}
                                    >
                                        <SubtaskLine client={client} convoId={event.convo_id} description={description}>
                                            <div className="mj_Markdown">
                                                <MarkdownBody text={body} label={String(event.seq)} />
                                            </div>
                                        </SubtaskLine>
                                    </TurnBlock>
                                );
                            })}
                        {helpers.map((helper) => (
                            <SubagentCard
                                key={helper.id}
                                child={helper}
                                kind={workerKind(helper)}
                                source={client}
                                onOpen={openHelper}
                                renderDetail={renderStepDetail}
                                renderMarkdown={renderMarkdown}
                                developerView={false}
                            />
                        ))}
                        {breaks.map(block)}
                        {turn.errors.map((event) => (
                            <TurnBlock
                                key={event.seq}
                                event={event}
                                rowHandlers={rowHandlers}
                                highlighted={highlightedSeq === event.seq}
                                live={false}
                            >
                                <TurnErrorRow
                                    text={asString(event.payload.body)
                                        .trim()
                                        .replace(/^⚠️?\s*/u, "")
                                        .replace(/^\[(.*)\]$/, "$1")}
                                />
                            </TurnBlock>
                        ))}
                        {turn.answer.map(block)}
                    </div>
                </div>
            </div>
        </li>
    );
}

/** A bridge system notice (`.mj_SystemNotice`): one tertiary meta line, no avatar. */
function TurnNoticeRow({
    event,
    highlighted,
    text,
}: {
    event: JournalEvent;
    highlighted: boolean;
    /** Display copy override (e.g. "Restarting with browser tools…"). */
    text?: string;
}): React.ReactElement {
    const body = asString(event.payload.body);
    return (
        <li
            className={`mj_SystemNotice${highlighted ? " mj_EventRow_searchHighlighted" : ""}`}
            data-event-id={event.seq}
            aria-live="polite"
            title={body}
        >
            {text ?? noticeText(body)}
        </li>
    );
}

// Every prop is stable while an agent streams (the event objects, the memoised reply and outcome
// maps, the menu handlers), so a streamed token re-renders only the streaming bubble instead of
// every row in a long transcript.
const MemoEventRow = React.memo(EventRow);

function MsgAvatar(): React.ReactElement {
    const mask = `url("${matronLogo}")`;

    return <span className="mj_MsgAvatar" style={{ WebkitMaskImage: mask, maskImage: mask }} aria-hidden />;
}

/** How much of the stream tail a collapsed tool-stream pane renders; it only shows a few lines. */
export const TOOL_STREAM_COLLAPSED_CAP_CHARS = 4096;

// The tail a collapsed pane renders, opened at a line boundary so the cut never starts mid-word
// or inside an escape sequence, unless the first line is long (then the tail is effectively one
// line and trimming through it would drop nearly everything). `cut` says if anything was dropped.
export function collapsedToolStreamSlice(text: string): { text: string; cut: boolean } {
    if (text.length <= TOOL_STREAM_COLLAPSED_CAP_CHARS) return { text, cut: false };
    const tail = text.slice(cleanCutStart(text, text.length - TOOL_STREAM_COLLAPSED_CAP_CHARS));
    const newline = tail.slice(0, 512).indexOf("\n");
    return { text: newline >= 0 ? tail.slice(newline + 1) : tail, cut: true };
}

// Where a cut at `start` can open cleanly: past the rest of an escape sequence it landed inside
// (any fragment, not only "[…m"), and past the low half of a surrogate pair it split. Unlike a
// head-truncated buffer, the text before the cut is at hand, so the fix is exact.
function cleanCutStart(text: string, start: number): number {
    const lookback = Math.max(0, start - 64);
    const escAt = text.slice(lookback, start).lastIndexOf("\x1b");
    if (escAt >= 0) {
        const esc = lookback + escAt;
        let end = esc + 2; // ESC + one byte, for a non-CSI escape
        if (text[esc + 1] === "[") {
            while (end < text.length) {
                const code = text.charCodeAt(end);
                end++;
                if (code >= 0x40 && code <= 0x7e) break;
            }
        }
        if (end > start) start = end;
    }
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start++;
    return start;
}

export function ToolStream({ stream }: { stream: ToolStreamState }): React.ReactElement {
    // Mac ToolStreamCard: collapsed to the last few lines, expandable to a taller scrolling pane.
    const [expanded, setExpanded] = useState(false);
    const nodes = useMemo(() => {
        let shown = stream.headTruncated ? stripLeadingSgrFragment(stream.content) : stream.content;
        let cut = stream.headTruncated;
        if (!expanded) {
            const sliced = collapsedToolStreamSlice(shown);
            shown = sliced.text;
            cut = cut || sliced.cut;
        }
        return parseAnsi(cut ? `… earlier output omitted …\n${shown}` : shown, INITIAL_SGR_STATE, "", 0).nodes;
    }, [stream.content, stream.headTruncated, expanded]);
    // Stay pinned to the newest output unless the user has scrolled up.
    const paneRef = useRef<HTMLPreElement>(null);
    const pinned = useRef(true);
    useLayoutEffect(() => {
        const pane = paneRef.current;
        if (pane && pinned.current) pane.scrollTop = pane.scrollHeight;
    }, [nodes]);
    const onScroll = (): void => {
        const pane = paneRef.current;
        if (pane) pinned.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 8;
    };

    return (
        <li className="mj_EventTile mj_EventTile_lastInSection" tabIndex={-1} data-layout="bubble" data-self="false">
            <span className="mj_SenderName">
                <MsgAvatar />
                <span className="mj_SenderName_displayName">agent</span>
            </span>
            <div className="mj_EventTile_line">
                <div className="mj_TextBody mj_EventTile_content">
                    <div className="markdown-body mj_LiveTool">
                        <div className="mj_LiveTool_header">
                            <span>
                                <span className="mj_LiveDot" /> Running{" "}
                                <code>{stream.command || stream.tool || "tool"}</code>
                            </span>
                            <button
                                type="button"
                                className="mj_LiveTool_toggle"
                                aria-expanded={expanded}
                                aria-label={expanded ? "Collapse output" : "Expand output"}
                                onClick={() => {
                                    // Like the Mac pane's bottom anchor: the resized pane opens on the newest output.
                                    pinned.current = true;
                                    setExpanded((current) => !current);
                                }}
                            >
                                <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
                                    <path
                                        d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"}
                                        fill="none"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </button>
                        </div>
                        <pre
                            ref={paneRef}
                            onScroll={onScroll}
                            className={expanded ? "mj_LiveTool_expanded" : "mj_LiveTool_collapsed"}
                        >
                            {nodes}
                        </pre>
                    </div>
                </div>
            </div>
        </li>
    );
}

function attachmentErrorMessage(message: PendingMessage): string {
    if (message.errorMessage) return message.errorMessage;
    switch (message.errorKind) {
        case "too_large":
            return "File too large.";
        case "browser_memory_limit":
            return "This file is too large for this browser to upload safely.";
        case "empty":
            return "That file is empty.";
        case "electron_binary_unsupported":
            return message.errorMessage || "Attachments aren't supported in the desktop build yet.";
        case "send_failed":
            return "Couldn't send attachment.";
        case "storage_failed":
            return "Couldn't save attachment.";
        case "upload_failed":
        default:
            return "Couldn't upload attachment.";
    }
}

function PendingAttachment({
    client,
    message,
    isReadOnly = false,
}: {
    client: MatronJournalClient;
    message: PendingMessage;
    isReadOnly?: boolean;
}): React.ReactElement {
    const filename = message.filename || (message.kind === "image" ? "Image" : "Attachment");
    const detail = formatBytes(message.size);
    const [recoveryAction, setRecoveryAction] = useState<"retry" | "dismiss">();
    const [recoveryError, setRecoveryError] = useState<string>();
    const [recoveryResult, setRecoveryResult] = useState<string>();

    const recover = async (action: "retry" | "dismiss"): Promise<void> => {
        setRecoveryAction(action);
        setRecoveryError(undefined);
        setRecoveryResult(undefined);
        try {
            if (action === "retry") await client.retryAttachment(message.localId);
            else await client.dismissAttachment(message.localId);
            // Only "dismiss" reports completion. A successful retry clears the
            // error state, which unmounts this whole error block — so a "Retry
            // completed." message is only ever visible when the retry actually
            // FAILED (the chip is still in error), which made it misleading.
            if (action === "dismiss") setRecoveryResult("Dismissed.");
        } catch (error) {
            setRecoveryError(`${action === "retry" ? "Retry" : "Dismiss"} failed: ${errorMessage(error)}`);
        } finally {
            setRecoveryAction(undefined);
        }
    };

    return (
        <li
            className={`mj_EventTile mj_EventTile_lastInSection mj_AttachmentChip mj_AttachmentChip_${message.attachState ?? "sending"}`}
            data-layout="bubble"
            data-self="true"
        >
            <div className="mj_AttachmentChip_content">
                <span className="mj_AttachmentChip_name">{filename}</span>
                {message.caption && <span className="mj_AttachmentChip_caption">{message.caption}</span>}
                {detail && <span className="mj_AttachmentChip_size">{detail}</span>}
            </div>
            {message.attachState === "uploading" && (
                <span className="mj_AttachmentChip_status" role="status">
                    <span className="mj_AttachmentChip_spinner" aria-hidden="true" />
                    Uploading…
                </span>
            )}
            {message.attachState === "sending" && (
                <span className="mj_AttachmentChip_status" role="status">
                    Sending…
                </span>
            )}
            {message.attachState === "error" && (
                <div className="mj_AttachmentChip_error" role="alert">
                    <span>{attachmentErrorMessage(message)}</span>
                    {recoveryError && <span>{recoveryError}</span>}
                    {recoveryResult && <span role="status">{recoveryResult}</span>}
                    <div className="mj_AttachmentChip_actions">
                        {!isReadOnly && message.canRetry && (
                            <button
                                type="button"
                                disabled={recoveryAction !== undefined}
                                onClick={() => void recover("retry")}
                            >
                                {recoveryAction === "retry" ? "Retrying…" : "Retry"}
                            </button>
                        )}
                        <button
                            type="button"
                            disabled={recoveryAction !== undefined}
                            onClick={() => void recover("dismiss")}
                        >
                            {recoveryAction === "dismiss" ? "Dismissing…" : "Dismiss"}
                        </button>
                    </div>
                </div>
            )}
        </li>
    );
}

/** The operator message nearest the top of the scroll pane, and its offset from the top. */
function operatorAnchor(node: HTMLElement | null): { seq: string; offset: number } | undefined {
    if (!node) return undefined;
    const paneTop = node.getBoundingClientRect().top;
    let best: { seq: string; offset: number } | undefined;
    for (const row of node.querySelectorAll<HTMLElement>('li[data-self="true"][data-event-id]')) {
        const offset = row.getBoundingClientRect().top - paneTop;
        const seq = row.dataset.eventId;
        if (!seq) continue;
        // The first row at or below the top edge wins; otherwise the last one above it.
        if (offset >= 0) return { seq, offset };
        best = { seq, offset };
    }
    return best;
}

/**
 * The floating "stop the current turn" control, top-trailing over the timeline. Shown while
 * the durable run-state says a turn is running; a tap sends the bridge's `!esc` interrupt —
 * exactly what typing `!esc` in the composer sends — without touching the draft. The send
 * lands in the timeline as an ordinary own-message, so that echo is the feedback; a second
 * tap while the first is still being queued is dropped rather than sending `!esc` twice.
 * Mounted keyed by conversation, so the linger after a turn and the in-flight latch both
 * belong to one conversation and never carry over to another.
 */
function StopTurnButton({
    client,
    conversationId,
    running,
}: {
    client: MatronJournalClient;
    conversationId: string;
    running: boolean;
}): React.ReactElement | null {
    const visible = useMinDisplayDuration(running);
    const sending = useRef(false);
    if (!visible) return null;
    return (
        <button
            className="mj_StopTurn"
            type="button"
            aria-label="Stop the current turn"
            title="Stop the current turn — sends !esc"
            onClick={() => {
                if (sending.current) return;
                sending.current = true;
                void client
                    .sendMessage("!esc", conversationId)
                    .catch((error) => console.warn("Stop command failed to send:", error))
                    .finally(() => {
                        sending.current = false;
                    });
            }}
        >
            <StopIcon />
        </button>
    );
}

const MIN_DISPLAY_MS = 500;

/**
 * Holds a brief `active` flag true for MIN_DISPLAY_MS after it last was, so a short turn
 * doesn't flash the control on and off.
 */
function useMinDisplayDuration(active: boolean): boolean {
    const [held, setHeld] = useState(active);
    useEffect(() => {
        if (active) {
            setHeld(true);
            return;
        }
        const timer = setTimeout(() => setHeld(false), MIN_DISPLAY_MS);
        return () => clearTimeout(timer);
    }, [active]);
    return active || held;
}

type TimelineRow =
    | { key: string; kind: "divider"; timestamp: number }
    | { key: string; kind: "event"; event: JournalEvent; continuation: boolean; lastInSection: boolean }
    | { key: string; kind: "pending"; message: ClientState["pendingMessages"][number] }
    // Show the work OFF: one agent tile per operator turn, and a bridge notice as a one-line row.
    | { key: string; kind: "turn"; turn: Turn }
    | { key: string; kind: "notice"; event: JournalEvent }
    // Developer view: a helper's card, after the event it started at.
    | { key: string; kind: "helper"; child: Conversation };

/** Height assumed for a row that hasn't been on screen yet. */
function estimateTimelineRow(key: string): number {
    return key.includes(":d-") ? 40 : 96;
}

function isAnchorableTimelineRow(key: string): boolean {
    return !key.includes(":d-");
}

/** Scrolling up to within this many screens of the oldest loaded message loads the page before it. */
const AUTO_LOAD_HISTORY_SCREENS = 2;
/** How long after the reader's last wheel, touch, key or pointer input a scroll still counts as theirs. */
const SCROLL_INPUT_MS = 2000;

/** Where the reader left each conversation, for this signed-in client; at the bottom when absent. */
const readingPlaces = new WeakMap<MatronJournalClient, Map<string, ListPlace>>();
function placesFor(client: MatronJournalClient): Map<string, ListPlace> {
    let places = readingPlaces.get(client);
    if (!places) {
        places = new Map();
        readingPlaces.set(client, places);
    }
    return places;
}

function Timeline({
    client,
    state,
    isReadOnly = false,
}: {
    client: MatronJournalClient;
    state: ClientState;
    isReadOnly?: boolean;
}): React.ReactElement {
    const scrollRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLOListElement>(null);
    const pendingScrollFrame = useRef<number | undefined>(undefined);
    const selectedConversationId = useRef(state.selectedConversationId);
    // Opening a conversation goes to its bottom, or back to where the reader left it (see below).
    const [isFollowingTail, setFollow] = useState(
        () => !(state.selectedConversationId && placesFor(client).has(state.selectedConversationId)),
    );
    const [sourceEvent, setSourceEvent] = useState<JournalEvent>();
    const [showTheWork] = useShowTheWork();
    const turnsRef = useRef<Turn[]>([]);
    // Show the work toggled: re-render instantly, keeping the operator message nearest the top
    // where it was (GENERATIVE-SYSTEM §7). Captured during render, while the DOM still shows the
    // previous rendering; restored in the layout effect below.
    const shownWorkRef = useRef(showTheWork);
    const toggleAnchorRef = useRef<{ seq: string; offset: number } | undefined>(undefined);
    if (shownWorkRef.current !== showTheWork) {
        shownWorkRef.current = showTheWork;
        toggleAnchorRef.current = operatorAnchor(scrollRef.current);
    }
    const menu = useRowContextMenu<JournalEvent>();
    const sourceOpenerRef = useRef<HTMLElement | null>(null);
    // Media viewer: the corpus is every image/file event in this conversation;
    // openViewer is threaded to AuthenticatedMedia via MediaViewerContext.
    const [viewerMediaId, setViewerMediaId] = useState<string>();
    const viewerOpenerRef = useRef<HTMLElement | null>(null);
    const mediaCorpus = useMemo<MediaItem[]>(() => buildMediaCorpus(state.events), [state.events]);
    const openViewer = useCallback((mediaId: string, opener: HTMLElement | null): void => {
        viewerOpenerRef.current = opener;
        setViewerMediaId(mediaId);
    }, []);
    const mediaViewerValue = useMemo<MediaViewerContextValue>(() => ({ openViewer }), [openViewer]);
    selectedConversationId.current = state.selectedConversationId;

    useEffect(() => {
        menu.close();
        setSourceEvent(undefined);
        setViewerMediaId(undefined);
    }, [state.selectedConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

    const historyScrollAnchor = useRef<
        | {
              conversationId?: string;
              scrollHeight: number;
              scrollTop: number;
              oldestSeq?: number;
          }
        | undefined
    >(undefined);
    const historyScrollRestored = useRef(false);
    const { queuedReleasePromptSeqs, legacyQueuePromptSeqs, permissionRequestSeqs } = useMemo(() => {
        const queuedReleasePromptSeqs = new Set<number>();
        const legacyQueuePromptSeqs = new Set<number>();
        const permissionRequestSeqs = new Set<number>();
        for (const event of state.events) {
            if (event.type === "permission_request") {
                permissionRequestSeqs.add(event.seq);
                continue;
            }
            if (event.type !== "prompt") continue;
            if (asString(event.payload.kind) === "queued_release") queuedReleasePromptSeqs.add(event.seq);
            else if (isLegacyQueuePrompt(event)) legacyQueuePromptSeqs.add(event.seq);
        }
        return { queuedReleasePromptSeqs, legacyQueuePromptSeqs, permissionRequestSeqs };
    }, [state.events]);
    // One card per tracker item, at its latest card marker, in its latest state (foldItemCards).
    const itemCards = useMemo(() => foldItemCards(state.events), [state.events]);
    const visibleEvents = useMemo(
        () =>
            state.events.filter(
                (event) =>
                    !isFoldedTranscriptEvent(event, {
                        queuedReleasePromptSeqs,
                        legacyQueuePromptSeqs,
                        permissionRequestSeqs,
                        itemCards,
                    }),
            ),
        [state.events, queuedReleasePromptSeqs, legacyQueuePromptSeqs, permissionRequestSeqs, itemCards],
    );
    const timeline = useMemo(
        () =>
            [
                ...visibleEvents.map((event) => ({ kind: "event" as const, timestamp: event.ts, event })),
                ...state.pendingMessages.map((message) => ({
                    kind: "pending" as const,
                    timestamp: message.createdAt,
                    message,
                })),
            ].sort((left, right) => left.timestamp - right.timestamp),
        [visibleEvents, state.pendingMessages],
    );
    // One entry per element in the list: a day divider before the first row of each calendar day,
    // then the row. Windowing mounts a slice of these.
    const eventRows = useMemo(() => {
        const conversation = state.selectedConversationId ?? "";
        const out: TimelineRow[] = [];
        timeline.forEach((item, index) => {
            const previous = timeline[index - 1];
            const newDay = !previous || !sameCalendarDay(item.timestamp, previous.timestamp);
            if (newDay) {
                // Keyed by the day, not by its first row, so the key survives older rows of the same
                // day arriving with "Load earlier messages".
                const day = new Date(item.timestamp);
                const dayKey = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
                out.push({ key: `${conversation}:d-${dayKey}`, kind: "divider", timestamp: item.timestamp });
            }
            if (item.kind === "event") {
                const next = timeline[index + 1];
                out.push({
                    key: `${conversation}:e-${item.event.seq}`,
                    kind: "event",
                    event: item.event,
                    continuation: previous?.kind === "event" && sameSection(previous.event, item.event) && !newDay,
                    lastInSection: next?.kind !== "event" || !sameSection(item.event, next.event),
                });
            } else {
                out.push({ key: `${conversation}:m-${item.message.localId}`, kind: "pending", message: item.message });
            }
        });
        return out;
    }, [timeline, state.selectedConversationId]);
    const answeredPromptReplies = useMemo(() => {
        const replies = new Map<string, { choice?: string }>();
        for (const event of state.events) {
            if (event.type !== "prompt_reply") continue;
            const targetSeq = asNumber(event.payload.target_seq, Number.NaN);
            if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) continue;
            const choice = asString(event.payload.choice, asString(event.payload.label)) || undefined;
            replies.set(`${event.convo_id}:${targetSeq}`, { choice });
        }
        return replies;
    }, [state.events]);
    // Durable, journaled resolution of an agent_spawn ask — no local persistence (§ design
    // "Resolution state"). A card whose request_id has an entry here is resolved across
    // restarts and devices because the spawn_outcome event is journaled, not client state.
    const spawnOutcomes = useMemo(() => {
        const outcomes = new Map<string, EventPayload>();
        for (const event of state.events) {
            if (event.type !== "spawn_outcome") continue;
            // A non-string request_id (malformed/missing) must never coerce into the map — a
            // bare `String(...)` here produces a junk "undefined" key that a card whose own
            // request_id happens to stringify the same way could spuriously match (Task-1
            // review scope D).
            if (typeof event.payload.request_id !== "string") continue;
            outcomes.set(event.payload.request_id, event.payload);
        }
        return outcomes;
    }, [state.events]);
    // Agent-chat cards settled by the timeline itself (the consent item's closing marker): a
    // decision made on another device, or the ask lapsing.
    const agentChatResolutions = useMemo(() => readAgentChatResolutions(state.events), [state.events]);
    // The Coordinator's answers to chat and spawn cards (`consent_decision`), for their badges.
    const coordinatorDecisions = useMemo(() => readCoordinatorDecisions(state.events), [state.events]);
    const releasedActions = useMemo(() => {
        const actions = new Map<string, "send" | "cancel" | "expired">();
        for (const event of state.events) {
            if (
                event.type !== "prompt_reply" ||
                asString(event.payload.kind) !== "queued_release" ||
                !Array.isArray(event.payload.released)
            )
                continue;
            const action = asString(event.payload.action);
            if (action !== "send" && action !== "cancel" && action !== "expired") continue;
            for (const releasedId of event.payload.released) {
                const itemId = asString(releasedId);
                if (!itemId) continue;
                // Terminal precedence: a real resolution (send/cancel) is FINAL
                // and outranks a later — or earlier — `expired` release for the
                // same item. This neutralizes the bridge's
                // narrow disk-fail-then-restart re-expiry: even if the bridge
                // re-emits `expired` for a release it already committed as
                // sent/cancelled, the card keeps showing the true result.
                // Precedence: send = cancel > expired. Order-independent.
                if (action === "expired") {
                    const prev = actions.get(itemId);
                    if (prev === "send" || prev === "cancel") continue; // never downgrade
                }
                actions.set(itemId, action);
            }
        }
        return actions;
    }, [state.events]);
    const resolvedAction = useCallback(
        (itemId: string): "send" | "cancel" | "expired" | undefined => releasedActions.get(itemId),
        [releasedActions],
    );
    const sessionRunning = client.selectedConversation()?.session_state === "running";
    // Inside a helper's own thread the turn's steps read as headlines (AgentTurnRow).
    const selectedForHeadlines = client.selectedConversation();
    const helperWorker =
        selectedForHeadlines && isSubChat(selectedForHeadlines) ? workerKind(selectedForHeadlines) : undefined;
    const helperThread = useMemo(() => (helperWorker === undefined ? null : { worker: helperWorker }), [helperWorker]);
    const sessionState = client.selectedConversation()?.session_state;

    // ---- v6: "Show the work" OFF — one agent tile per operator turn with an Under-the-hood card.
    const turns = useMemo(() => (showTheWork ? [] : assembleTurns(visibleEvents)), [showTheWork, visibleEvents]);
    turnsRef.current = turns;
    // Helpers (subagents, Codex runs) this conversation started: one card each, anchored to the
    // turn — or, with Developer view on, the event — they were started in.
    const helperChildren = useMemo(
        () => childrenOf(state.conversations, state.selectedConversationId),
        [state.conversations, state.selectedConversationId],
    );
    const turnHelpers = useMemo(
        () =>
            showTheWork
                ? new Map<string, Conversation[]>()
                : helpersByTurn(turns, helperChildren, state.hasOlderHistory),
        [showTheWork, turns, helperChildren, state.hasOlderHistory],
    );
    const eventHelpers = useMemo(() => {
        const map = new Map<number, Conversation[]>();
        if (!showTheWork || visibleEvents.length === 0) return map;
        for (const child of helperChildren) {
            let anchor: JournalEvent | undefined;
            for (const event of visibleEvents) if (event.ts <= child.created_at) anchor = event;
            if (!anchor) {
                if (state.hasOlderHistory) continue;
                anchor = visibleEvents[0];
            }
            map.set(anchor.seq, [...(map.get(anchor.seq) ?? []), child]);
        }
        return map;
    }, [showTheWork, visibleEvents, helperChildren, state.hasOlderHistory]);
    const browserNoticeSeqs = useMemo(
        () => (showTheWork ? new Set<number>() : browserRestartNoticeSeqs(visibleEvents)),
        [showTheWork, visibleEvents],
    );
    const lastTurn = liveTurnOf(turns);
    // Inside a helper's thread the newest turns open with their work in view; older ones keep
    // the compact list, which bounds the DOM on a long thread (EXPANDED_HELPER_TURNS).
    const expandedHelperTurns = useMemo(
        () =>
            new Set(
                helperThread
                    ? turns
                          .filter((turn) => stepsOf(turn.items).length > 0)
                          .slice(-EXPANDED_HELPER_TURNS)
                          .map((turn) => turn.key)
                    : [],
            ),
        [helperThread, turns],
    );
    // First-seen time of each live step, so the elapsed counter and slow state survive re-renders.
    const liveSeenRef = useRef(new Map<string, number>());
    const liveStreams = useMemo(
        () => (sessionRunning ? Object.values(state.toolStreams) : []),
        [sessionRunning, state.toolStreams],
    );
    const activityDetail = sessionRunning && state.activity?.state === "tool" ? state.activity.detail || "" : "";
    // The running step, stable across stream chunks (keyed on the stream, not its content).
    const lastStream = liveStreams.at(-1);
    const streamKey = lastStream
        ? `${lastStream.messageRef}\u0000${lastStream.command ?? ""}\u0000${lastStream.tool ?? ""}`
        : "";
    const streamStep = useMemo((): Step | null => {
        if (!streamKey) return null;
        const [messageRef, command, tool] = streamKey.split("\u0000");
        return {
            kind: "step",
            id: `live-${messageRef}`,
            tool: tool && tool !== "Bash" && !command ? tool : "Bash",
            input: { command: command || tool },
            status: "running",
        };
    }, [streamKey]);
    const activityRunning = useMemo(
        () => (activityDetail ? activityStep(activityDetail, "live-activity") : null),
        [activityDetail],
    );
    const lastTurnLive = useMemo((): TurnLive => {
        if (!lastTurn) return { mode: "done" };
        const lastStep = stepsOf(lastTurn.items).at(-1);
        const waiting =
            (sessionState === "running" || sessionState === "waiting") &&
            lastTurn.breaks.some((event) => isUnansweredAsk(event, answeredPromptReplies, spawnOutcomes));
        if (waiting) return { mode: "waiting" };
        if (!sessionRunning) return { mode: lastStep?.status === "stopped" ? "stopped" : "done" };
        const seen = liveSeenRef.current;
        // Only the step running NOW keeps a clock: a repeat of the same command later starts fresh.
        const since = (key: string): number => {
            for (const known of [...seen.keys()]) if (known !== key) seen.delete(known);
            const known = seen.get(key);
            if (known !== undefined) return known;
            const now = Date.now();
            seen.set(key, now);
            return now;
        };
        if (streamStep) {
            return { mode: "running", running: streamStep, runningSince: since(`stream:${streamStep.id}`) };
        }
        if (activityRunning) {
            return { mode: "running", running: activityRunning, runningSince: since(`activity:${activityDetail}`) };
        }
        seen.clear();
        const thinking =
            state.activity?.state === "thinking" && state.activity.detail
                ? narrationLiveLine(state.activity.detail)
                : undefined;
        return { mode: "running", liveText: thinking ?? "Thinking…" };
    }, [
        lastTurn,
        sessionState,
        sessionRunning,
        state.activity,
        streamStep,
        activityRunning,
        activityDetail,
        answeredPromptReplies,
        spawnOutcomes,
    ]);
    const turnRows = useMemo(
        () => threadRows(turns, { liveLastTurn: lastTurnLive.mode === "running" && Boolean(lastTurnLive.running) }),
        [turns, lastTurnLive],
    );
    // Forget first-seen stamps once nothing is running, so a later step starts its own clock.
    useEffect(() => {
        if (!sessionRunning) liveSeenRef.current.clear();
    }, [sessionRunning]);
    // With Show the work OFF the card's live line replaces the typing indicator — except while
    // the turn has no card yet (the agent is thinking before its first step).
    const lastTurnHasCard =
        lastTurn !== undefined && (stepsOf(lastTurn.items).length > 0 || Boolean(lastTurnLive.running));
    const showActivityIndicator = showTheWork || !lastTurnHasCard;
    // With Show the work OFF the list is one row per operator turn (plus peer messages, notices and
    // pending sends) in place of one row per event; the windowing below treats both the same.
    const displayRows = useMemo((): TimelineRow[] => {
        const conversation = state.selectedConversationId ?? "";
        const out: TimelineRow[] = [];
        if (showTheWork) {
            if (eventHelpers.size === 0) return eventRows;
            for (const row of eventRows) {
                out.push(row);
                if (row.kind !== "event") continue;
                for (const child of eventHelpers.get(row.event.seq) ?? []) {
                    out.push({ key: `${conversation}:h-${child.id}`, kind: "helper", child });
                }
            }
            return out;
        }
        const rowTs = (candidate: ThreadRow | undefined): number | undefined =>
            candidate === undefined
                ? undefined
                : candidate.kind === "turn"
                  ? (candidate.turn.events[0]?.ts ?? candidate.turn.startTs)
                  : candidate.event.ts;
        const dayKeyOf = (timestamp: number): string => {
            const day = new Date(timestamp);
            return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
        };
        let lastTs: number | undefined;
        const divide = (timestamp: number): void => {
            if (lastTs === undefined || !sameCalendarDay(timestamp, lastTs)) {
                out.push({ key: `${conversation}:d-${dayKeyOf(timestamp)}`, kind: "divider", timestamp });
            }
        };
        const sameSenderAs = (candidate: ThreadRow | undefined, row: ThreadRow): boolean =>
            candidate !== undefined &&
            (candidate.kind === "operator" || candidate.kind === "peer") &&
            (row.kind === "operator" || row.kind === "peer") &&
            candidate.event.sender === row.event.sender;
        turnRows.forEach((row, index) => {
            const ts = rowTs(row)!;
            divide(ts);
            const previous = turnRows[index - 1];
            const next = turnRows[index + 1];
            const newDay = lastTs === undefined || !sameCalendarDay(ts, lastTs);
            if (row.kind === "turn") {
                out.push({ key: `${conversation}:t-${row.turn.key}`, kind: "turn", turn: row.turn });
                lastTs = row.turn.events.at(-1)?.ts ?? row.turn.endTs;
                return;
            }
            lastTs = row.event.ts;
            if (row.kind === "notice") {
                out.push({ key: `${conversation}:e-${row.event.seq}`, kind: "notice", event: row.event });
                return;
            }
            out.push({
                key: `${conversation}:e-${row.event.seq}`,
                kind: "event",
                event: row.event,
                continuation: sameSenderAs(previous, row) && !newDay,
                lastInSection: !sameSenderAs(next, row),
            });
        });
        for (const row of eventRows) {
            if (row.kind !== "pending") continue;
            divide(row.message.createdAt);
            lastTs = row.message.createdAt;
            out.push(row);
        }
        return out;
    }, [showTheWork, eventRows, turnRows, eventHelpers, state.selectedConversationId]);
    const rowKeys = useMemo(() => displayRows.map((row) => row.key), [displayRows]);
    const scrollToBottom = useCallback((): void => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, []);
    const cancelPendingScrollFrame = useCallback((): void => {
        if (pendingScrollFrame.current === undefined) return;
        cancelAnimationFrame(pendingScrollFrame.current);
        pendingScrollFrame.current = undefined;
    }, []);
    const lastScrollTop = useRef(0);
    const lastScrollHeight = useRef(0);
    // When the reader last did something that scrolls the transcript (a wheel, a touch, a key, the
    // scrollbar); scrolling within SCROLL_INPUT_MS of it, momentum included, is theirs.
    const lastScrollInput = useRef(-Infinity);
    useEffect(() => {
        const node = scrollRef.current;
        if (!node) return;
        const mark = (): void => {
            lastScrollInput.current = performance.now();
        };
        const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
        for (const type of inputs) node.addEventListener(type, mark, { passive: true });
        return () => {
            for (const type of inputs) node.removeEventListener(type, mark);
        };
    }, []);
    // A remembered place waiting for its conversation's rows to arrive (see the restore below).
    const pendingPlace = useRef<{ conversationId: string; place: ListPlace } | undefined>(undefined);
    const onScroll = (): void => {
        const node = scrollRef.current;
        if (!node) return;
        windowed.onScroll();
        // Scrolling up towards the oldest loaded message fetches the page before it, so the reader
        // never has to stop at the "Load earlier messages" button. Only the reader's own scrolling
        // counts: the app moves scrollTop too (restoring a place, keeping the anchor, jumping), and
        // so does the browser when the content changes height (switching conversation, rows
        // arriving).
        const scrolledUp =
            node.scrollTop < lastScrollTop.current &&
            node.scrollHeight === lastScrollHeight.current &&
            performance.now() - lastScrollInput.current < SCROLL_INPUT_MS;
        lastScrollTop.current = node.scrollTop;
        lastScrollHeight.current = node.scrollHeight;
        if (
            scrolledUp &&
            state.events[0]?.convo_id === state.selectedConversationId &&
            node.scrollTop < node.clientHeight * AUTO_LOAD_HISTORY_SCREENS &&
            state.hasOlderHistory &&
            !state.loadingHistory &&
            !pendingPlace.current
        ) {
            loadEarlierMessages();
        }
        cancelPendingScrollFrame();
        const queuedConversationId = state.selectedConversationId;
        pendingScrollFrame.current = requestAnimationFrame(() => {
            pendingScrollFrame.current = undefined;
            // While a remembered place is still being restored, the scroll is ours, not the reader's.
            if (selectedConversationId.current !== queuedConversationId || pendingPlace.current) return;
            const nearBottom = isNearBottom(node.scrollTop, node.scrollHeight, node.clientHeight);
            setFollow(nearBottom);
            // Remember where the reader is in this conversation, for when they come back to it.
            if (!queuedConversationId) return;
            const place = nearBottom ? null : windowed.place();
            if (place) placesFor(client).set(queuedConversationId, place);
            else placesFor(client).delete(queuedConversationId);
        });
    };

    // Opening a conversation goes to its bottom, or back to where the reader left it.
    useLayoutEffect(() => {
        const id = state.selectedConversationId;
        setFollow(!(id && placesFor(client).has(id)));
    }, [client, state.selectedConversationId]);

    useEffect(() => cancelPendingScrollFrame, [state.selectedConversationId, cancelPendingScrollFrame]);

    // A send goes to the bottom. Only a new send: on mount the timeline opens at the bottom anyway,
    // or at the remembered place.
    const seenSendTick = useRef(state.sendTick);
    useEffect(() => {
        if (seenSendTick.current === state.sendTick) return;
        seenSendTick.current = state.sendTick;
        cancelPendingScrollFrame();
        historyScrollAnchor.current = undefined;
        historyScrollRestored.current = false;
        pendingPlace.current = undefined;
        setFollow(true);
        scrollToBottom();
    }, [state.sendTick, cancelPendingScrollFrame, scrollToBottom]);

    useLayoutEffect(() => {
        const node = scrollRef.current;
        if (!node) return;

        const anchor = historyScrollAnchor.current;
        if (anchor) {
            if (anchor.conversationId !== state.selectedConversationId) {
                historyScrollAnchor.current = undefined;
                historyScrollRestored.current = false;
                node.scrollTop = node.scrollHeight;
                return;
            }
            const oldestSeq = visibleEvents[0]?.seq;
            const historyPrepended =
                oldestSeq !== undefined && (anchor.oldestSeq === undefined || oldestSeq < anchor.oldestSeq);
            if (historyPrepended || !state.loadingHistory) {
                node.scrollTop = anchor.scrollTop + node.scrollHeight - anchor.scrollHeight;
                historyScrollAnchor.current = undefined;
                historyScrollRestored.current = state.loadingHistory;
            }
            return;
        }

        if (historyScrollRestored.current) {
            if (!state.loadingHistory) historyScrollRestored.current = false;
            return;
        }

        if (isFollowingTail) node.scrollTop = node.scrollHeight;
    }, [
        state.selectedConversationId,
        visibleEvents,
        state.pendingMessages.length,
        state.textStreams,
        state.toolStreams,
        state.loadingHistory,
        isFollowingTail,
        showTheWork,
    ]);

    useLayoutEffect(() => {
        const anchor = toggleAnchorRef.current;
        toggleAnchorRef.current = undefined;
        const node = scrollRef.current;
        if (!anchor || !node || isFollowingTail) return;
        const row = node.querySelector<HTMLElement>(`[data-event-id="${anchor.seq}"]`);
        if (!row) return;
        node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
    }, [showTheWork]); // eslint-disable-line react-hooks/exhaustive-deps

    // Declared after the scroll effects above, so it measures once they have placed the scroller.
    const windowed = useWindowedList({
        scrollRef,
        keys: rowKeys,
        estimate: estimateTimelineRow,
        followTail: isFollowingTail,
        anchorable: isAnchorableTimelineRow,
        resetKey: state.selectedConversationId,
    });

    // Put the reader back at the remembered place once the conversation's rows are here. If the
    // row isn't among them (its history is no longer stored), open at the bottom as usual.
    const restoringFor = useRef<string | undefined>(undefined);
    const { restorePlace } = windowed;
    useLayoutEffect(() => {
        const conversationId = state.selectedConversationId;
        if (restoringFor.current !== conversationId) {
            restoringFor.current = conversationId;
            const place = conversationId ? placesFor(client).get(conversationId) : undefined;
            pendingPlace.current = conversationId && place ? { conversationId, place } : undefined;
        }
        // Wait for the render that has stopped following the tail, or the hook pins to the bottom.
        const pending = pendingPlace.current;
        if (!pending || isFollowingTail || state.events[0]?.convo_id !== pending.conversationId) return;
        pendingPlace.current = undefined;
        if (restorePlace(pending.place)) {
            lastScrollTop.current = scrollRef.current?.scrollTop ?? 0;
            return;
        }
        placesFor(client).delete(pending.conversationId);
        setFollow(true);
    }, [client, state.selectedConversationId, state.events, rowKeys, restorePlace, isFollowingTail]);

    // Read state: report which rows were on screen. A layout effect, so a conversation switch
    // re-binds before any row of the new conversation can be counted under the old one. A
    // read-only subagent transcript reports nothing.
    const seenConversationId = isReadOnly ? undefined : state.selectedConversationId;
    useLayoutEffect(() => {
        const root = scrollRef.current;
        const list = listRef.current;
        if (!seenConversationId || !root || !list) return;
        return observeSeenRows({ tracker: client.seen, convoId: seenConversationId, root, list });
    }, [client, seenConversationId]);

    // New messages are announced through a live region of their own. The list is not one: with
    // the transcript windowed, rows mount and unmount as the reader scrolls, and a live list would
    // read those out as if they had just arrived. Only a newer last event in the same conversation
    // counts, so opening a conversation and loading its history announce nothing.
    // A repeat of the same text would not change the region, so every other announcement ends in
    // a no-break space; a switch clears it.
    const [arrival, setArrival] = useState("");
    const lastEvent = useRef<{ conversationId: string; seq: number } | undefined>(undefined);
    useEffect(() => {
        const last = visibleEvents.at(-1);
        const previous = lastEvent.current;
        lastEvent.current = last && { conversationId: last.convo_id, seq: last.seq };
        if (!last || last.convo_id !== state.selectedConversationId || last.sender.startsWith("user:")) return;
        if (previous?.conversationId !== last.convo_id || last.seq <= previous.seq) return;
        const text = `${displaySender(last.sender)}: ${eventSnippet(last.type, last.payload) || "new message"}`;
        setArrival((current) => (current === text ? `${text}\u00a0` : text));
    }, [visibleEvents, state.selectedConversationId]);
    useLayoutEffect(() => setArrival(""), [state.selectedConversationId]);

    const loadEarlierMessages = (): void => {
        const node = scrollRef.current;
        if (node) {
            historyScrollAnchor.current = {
                conversationId: state.selectedConversationId,
                scrollHeight: node.scrollHeight,
                scrollTop: node.scrollTop,
                oldestSeq: visibleEvents[0]?.seq,
            };
        }
        void client.loadOlderHistory();
    };

    // Jump to a message: once the client has loaded the history holding the target seq it hands
    // over `focusTarget`; scroll that row into view and flash it. Rows are found by their
    // data-event-id, so the memoised rows take no extra props. The row may not be mounted (the
    // transcript is windowed), so it is revealed first at its estimated position. Sizing rows for
    // real as they mount moves the target, so the position is re-checked each frame until it holds
    // still — and given up the moment the user scrolls themself.
    const focusRun = useRef(0);
    const focusHighlight = useRef<{ row: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
    const focusTarget = state.focusTarget;
    const { reveal } = windowed;
    useLayoutEffect(() => {
        const node = scrollRef.current;
        if (!node || !focusTarget || focusTarget.conversationId !== state.selectedConversationId) return;
        client.clearFocusTarget(focusTarget.token);
        const seq = landingSeq(
            visibleEvents.map((event) => event.seq),
            focusTarget.seq,
        );
        let index = seq === undefined ? -1 : rowKeys.indexOf(`${state.selectedConversationId}:e-${seq}`);
        // Show the work OFF: a step or a narration line lives inside its turn's tile.
        const turnOfSeq =
            seq === undefined || index >= 0
                ? undefined
                : turnsRef.current.find((candidate) => candidate.events.some((event) => event.seq === seq));
        if (turnOfSeq) index = rowKeys.indexOf(`${state.selectedConversationId}:t-${turnOfSeq.key}`);
        if (index < 0) return;
        const rowFor = (): HTMLElement | null =>
            node.querySelector<HTMLElement>(`[data-event-id="${seq}"]`) ??
            (turnOfSeq ? node.querySelector<HTMLElement>(`li[data-turn="${turnOfSeq.key}"]`) : null);
        cancelPendingScrollFrame();
        historyScrollAnchor.current = undefined;
        historyScrollRestored.current = false;
        // A jump wins over a remembered place still waiting to be restored.
        pendingPlace.current = undefined;
        setFollow(false);
        if (!rowFor()) reveal(index);

        const flash = (row: HTMLElement): void => {
            const previous = focusHighlight.current;
            if (previous) {
                clearTimeout(previous.timer);
                previous.row.classList.remove("mj_EventTile_focused");
            }
            row.classList.add("mj_EventTile_focused");
            const timer = setTimeout(() => {
                row.classList.remove("mj_EventTile_focused");
                if (focusHighlight.current?.row === row) focusHighlight.current = undefined;
            }, FOCUS_HIGHLIGHT_MS);
            focusHighlight.current = { row, timer };
        };

        const run = ++focusRun.current;
        const stop = (): void => {
            if (focusRun.current === run) focusRun.current += 1;
        };
        const userScroll = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
        for (const type of userScroll) node.addEventListener(type, stop, { once: true, passive: true });
        let frames = 0;
        let still = 0;
        let flashed = false;
        const place = (): void => {
            const live = focusRun.current === run;
            const target = live ? rowFor() : null;
            if (target) {
                if (!flashed) {
                    flash(target);
                    flashed = true;
                }
                const top = focusScrollTop(node, target);
                if (Math.abs(node.scrollTop - top) > 1) {
                    node.scrollTop = top;
                    still = 0;
                } else {
                    still += 1;
                }
            }
            // Until the revealed row has mounted, keep waiting for it (within the frame budget).
            if (live && still < 3 && ++frames < 60) {
                requestAnimationFrame(place);
                return;
            }
            for (const type of userScroll) node.removeEventListener(type, stop);
        };
        place();
    }, [client, focusTarget, state.selectedConversationId, visibleEvents, rowKeys, reveal, cancelPendingScrollFrame]);
    useEffect(
        () => () => {
            focusRun.current += 1;
            if (focusHighlight.current) clearTimeout(focusHighlight.current.timer);
        },
        [],
    );

    // ⇧⌘U / Ctrl+Shift+U, the floating pill's shortcut, is bound with the app's other shortcuts
    // (shortcuts.ts useAppShortcuts), live whenever a conversation is open.

    // The activity indicator ('Thinking' / 'Running …') and the fire-and-forget tool-call cards
    // both ride ephemeral frames whose turn-end 'idle'/'end' frame is never replayed
    // (lib/journal-publisher.js publishActivity), so a dropped final frame would otherwise strand
    // a stale "Thinking" or a dangling 'running' tool card until the next turn. Gate both
    // on the durable, replayed run-state: only render while the session is actually running; the
    // model reconcile (refreshConversations) prunes any tool card that lingers in the map.
    const timelineMain = (
        <main className="mj_ChatView_timeline" data-testid="timeline">
            <div className="mj_ScreenReaderOnly" aria-live="polite" aria-atomic="true">
                {arrival}
            </div>
            <div className="mj_ChatView_messagePanel mj_AutoHideScrollbar" ref={scrollRef} onScroll={onScroll}>
                <ol className="mj_ChatView_messageList" ref={listRef}>
                    {state.hasOlderHistory && (
                        <li className="mj_HistoryRow">
                            <button
                                className="mj_LoadHistory"
                                onClick={loadEarlierMessages}
                                disabled={state.loadingHistory}
                            >
                                {state.loadingHistory ? "Loading…" : "Load earlier messages"}
                            </button>
                        </li>
                    )}
                    <li
                        className="mj_TimelineSpacer"
                        aria-hidden="true"
                        ref={windowed.beforeRef}
                        style={{ height: windowed.range.before }}
                    />
                    {displayRows.slice(windowed.range.start, windowed.range.end).map((row) => {
                        if (row.kind === "divider") {
                            // A centred dated label flanked by hairline rules (§ upload-first ref).
                            return (
                                <li key={row.key} className="mj_DateDivider" role="separator">
                                    <span className="mj_DateDivider_rule" aria-hidden="true" />
                                    <span className="mj_DateDivider_label">{formatDayDivider(row.timestamp)}</span>
                                    <span className="mj_DateDivider_rule" aria-hidden="true" />
                                </li>
                            );
                        }
                        if (row.kind === "turn") {
                            return (
                                <AgentTurnRow
                                    key={row.key}
                                    client={client}
                                    turn={row.turn}
                                    live={
                                        row.turn === lastTurn
                                            ? lastTurnLive
                                            : {
                                                  mode:
                                                      stepsOf(row.turn.items).at(-1)?.status === "stopped"
                                                          ? "stopped"
                                                          : "done",
                                              }
                                    }
                                    answeredPromptReplies={answeredPromptReplies}
                                    spawnOutcomes={spawnOutcomes}
                                    agentChatResolutions={agentChatResolutions}
                                    coordinatorDecisions={coordinatorDecisions}
                                    itemCards={itemCards}
                                    isReadOnly={isReadOnly}
                                    resolvedAction={resolvedAction}
                                    rowHandlers={menu.rowHandlers}
                                    helpers={turnHelpers.get(row.turn.key)}
                                    helperThread={helperThread}
                                    expandHeadlines={expandedHelperTurns.has(row.turn.key)}
                                />
                            );
                        }
                        if (row.kind === "notice") {
                            return (
                                <TurnNoticeRow
                                    key={row.key}
                                    event={row.event}
                                    highlighted={false}
                                    text={
                                        browserNoticeSeqs.has(row.event.seq)
                                            ? "Restarting with browser tools…"
                                            : undefined
                                    }
                                />
                            );
                        }
                        if (row.kind === "helper") {
                            return <DevHelperRow key={row.key} client={client} child={row.child} />;
                        }
                        if (row.kind === "event") {
                            return (
                                <MemoEventRow
                                    key={row.key}
                                    client={client}
                                    event={row.event}
                                    answeredPromptReplies={answeredPromptReplies}
                                    spawnOutcomes={spawnOutcomes}
                                    agentChatResolutions={agentChatResolutions}
                                    coordinatorDecisions={coordinatorDecisions}
                                    itemCards={itemCards}
                                    isReadOnly={isReadOnly}
                                    resolvedAction={resolvedAction}
                                    continuation={row.continuation}
                                    lastInSection={row.lastInSection}
                                    rowHandlers={menu.rowHandlers}
                                />
                            );
                        }
                        const message = row.message;
                        return message.kind === "image" || message.kind === "file" ? (
                            <PendingAttachment
                                key={row.key}
                                client={client}
                                message={message}
                                isReadOnly={isReadOnly}
                            />
                        ) : (
                            <li
                                key={row.key}
                                className="mj_EventTile mj_EventTile_sending mj_EventTile_lastInSection"
                                data-layout="bubble"
                                data-self="true"
                            >
                                <div className="mj_EventTile_line">
                                    <div className="mj_TextBody mj_EventTile_content">
                                        <div className="mj_Markdown">
                                            <MarkdownBody text={message.body} label={message.localId} />
                                        </div>
                                    </div>
                                </div>
                                <span className="mj_SendingLabel">Sending…</span>
                            </li>
                        );
                    })}
                    <li
                        className="mj_TimelineSpacer"
                        aria-hidden="true"
                        ref={windowed.afterRef}
                        style={{ height: windowed.range.after }}
                    />
                    {Object.values(state.textStreams).map((text, index) => (
                        <li
                            className="mj_EventTile mj_EventTile_lastInSection"
                            key={`text-stream-${index}`}
                            data-layout="bubble"
                            data-self="false"
                        >
                            <span className="mj_SenderName">
                                <MsgAvatar />
                                <span className="mj_SenderName_displayName">agent</span>
                            </span>
                            <div className="mj_EventTile_line">
                                <div className="mj_TextBody mj_EventTile_content">
                                    <div className="mj_Markdown mj_Markdown_streaming">
                                        <MarkdownBody text={text} streaming label={`stream-${index}`} />
                                        <span className="mj_Cursor" />
                                    </div>
                                </div>
                            </div>
                        </li>
                    ))}
                    {sessionRunning &&
                        showTheWork &&
                        Object.values(state.toolStreams).map((stream) => (
                            <ToolStream key={stream.messageRef} stream={stream} />
                        ))}
                    {showActivityIndicator && state.activity && state.activity.state !== "idle" && sessionRunning && (
                        <li className="mj_TypingIndicator mj_Activity">
                            <span />
                            <span />
                            <span />
                            {state.activity.state === "thinking"
                                ? "Thinking"
                                : `Running ${state.activity.detail || "a tool"}`}
                        </li>
                    )}
                </ol>
            </div>
            {!isReadOnly && state.selectedConversationId && (
                <StopTurnButton
                    key={state.selectedConversationId}
                    client={client}
                    conversationId={state.selectedConversationId}
                    running={sessionRunning}
                />
            )}
            {!isFollowingTail && (
                <button
                    type="button"
                    className="mj_JumpToLastOwn"
                    aria-label="Jump to my last message"
                    title={`Jump to my last message (${jumpToLastOwnShortcutLabel()})`}
                    onClick={() => void client.jumpToLastOwnMessage()}
                >
                    <ArrowUpToLineIcon aria-hidden />
                </button>
            )}
            {!isFollowingTail && (
                <button
                    className="mj_JumpToBottom"
                    aria-label="Jump to bottom"
                    onClick={() => {
                        pendingPlace.current = undefined;
                        setFollow(true);
                        scrollToBottom();
                    }}
                >
                    ↓
                </button>
            )}
            {menu.state && (
                <div
                    className="mj_HeaderMenu mj_EventRowMenu"
                    role="menu"
                    ref={menu.menuRef}
                    style={{ position: "fixed", left: menu.state.left, top: menu.state.top }}
                    onKeyDown={menu.menuKeyDown}
                >
                    {menu.state.target.type === "text" && (
                        <>
                            {/* Copy = readable plain text (markdown stripped); the raw markdown
                                SOURCE is offered separately below (§10.7 icon per row). */}
                            <button
                                className="mj_ConversationMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    void copyText(markdownToPlainText(asString(menu.state!.target.payload.body)));
                                    menu.close();
                                }}
                            >
                                <ClipboardIcon aria-hidden />
                                <span>Copy</span>
                            </button>
                            <button
                                className="mj_ConversationMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    // The journal stores the markdown source in payload.body.
                                    void copyText(asString(menu.state!.target.payload.body));
                                    menu.close();
                                }}
                            >
                                <MarkdownIcon aria-hidden />
                                <span>Copy as Markdown</span>
                            </button>
                            <MenuSeparator />
                        </>
                    )}
                    <button
                        className="mj_ConversationMenu_item"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            sourceOpenerRef.current = menu.openerRef.current;
                            setSourceEvent(menu.state!.target);
                            menu.close();
                        }}
                    >
                        <CodeBracketsIcon aria-hidden />
                        <span>View source</span>
                    </button>
                </div>
            )}
            {sourceEvent && (
                <EventSourceSheet
                    event={sourceEvent}
                    opener={sourceOpenerRef.current}
                    onClose={() => setSourceEvent(undefined)}
                />
            )}
            {viewerMediaId && mediaCorpus.length > 0 && (
                <MediaViewer
                    client={client}
                    items={mediaCorpus}
                    initialMediaId={viewerMediaId}
                    opener={viewerOpenerRef.current}
                    onClose={() => setViewerMediaId(undefined)}
                />
            )}
        </main>
    );

    return <MediaViewerContext.Provider value={mediaViewerValue}>{timelineMain}</MediaViewerContext.Provider>;
}

const SLASH_LISTBOX_ID = "mj_SlashPalette_listbox";
const slashRowId = (index: number): string => `${SLASH_LISTBOX_ID}_opt_${index}`;

// The palette's second mode, for a fully typed command: its arguments first (few and short), then
// any recent folders (up to eight), as the Mac composer orders them.
type PaletteSuggestion = { kind: "argument"; argument: ArgSuggestion } | { kind: "folder"; path: string };

function SlashCommandPalette({
    commands,
    suggestions,
    highlighted,
    onHighlight,
    onSelectCommand,
    onSelectSuggestion,
}: {
    commands: BotCommand[];
    suggestions: PaletteSuggestion[];
    highlighted: number | null;
    onHighlight: (index: number | null) => void;
    onSelectCommand: (command: BotCommand) => void;
    onSelectSuggestion: (suggestion: PaletteSuggestion) => void;
}): React.ReactElement {
    const highlightedRow = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (highlighted !== null) highlightedRow.current?.scrollIntoView({ block: "nearest" });
    }, [highlighted]);

    const rowProps = (
        index: number,
        onClick: () => void,
    ): React.HTMLAttributes<HTMLDivElement> & {
        ref?: React.Ref<HTMLDivElement>;
    } => ({
        className: `mj_SlashPalette_row${highlighted === index ? " mj_SlashPalette_row_highlighted" : ""}`,
        id: slashRowId(index),
        ref: highlighted === index ? highlightedRow : undefined,
        role: "option",
        "aria-selected": highlighted === index,
        onMouseEnter: () => onHighlight(index),
        onMouseDown: (event) => event.preventDefault(),
        onClick,
    });

    return (
        <div className="mj_SlashPalette" id={SLASH_LISTBOX_ID} role="listbox" aria-label="Suggestions">
            {suggestions.length > 0
                ? suggestions.map((suggestion, index) =>
                      suggestion.kind === "argument" ? (
                          <div
                              key={`arg:${suggestion.argument.value}`}
                              {...rowProps(index, () => onSelectSuggestion(suggestion))}
                          >
                              <span className="mj_SlashPalette_trigger">
                                  {suggestion.argument.label ?? suggestion.argument.value}
                              </span>
                              {suggestion.argument.summary && (
                                  <span className="mj_SlashPalette_summary">{suggestion.argument.summary}</span>
                              )}
                          </div>
                      ) : (
                          <div
                              key={`dir:${suggestion.path}-${index}`}
                              {...rowProps(index, () => onSelectSuggestion(suggestion))}
                          >
                              <span className="mj_SlashPalette_trigger">{suggestion.path}</span>
                          </div>
                      ),
                  )
                : commands.map((command, index) => (
                      <div key={command.trigger} {...rowProps(index, () => onSelectCommand(command))}>
                          <span className="mj_SlashPalette_trigger">{command.trigger}</span>
                          {command.argHint && <span className="mj_SlashPalette_argHint">{command.argHint}</span>}
                          <span className="mj_SlashPalette_summary">{command.summary}</span>
                      </div>
                  ))}
        </div>
    );
}

/**
 * A conversation's voice note finished while no composer is mounted (stopped from the app-wide bar
 * on another page): it goes out on its own. Resolves to why it didn't, for the bar's Retry row.
 */
async function sendVoiceNoteAway(
    client: MatronJournalClient,
    blob: Blob,
    { contextKey, sessionGen }: VoiceRecordingContext,
): Promise<string | null> {
    try {
        const outcome = await client.sendVoiceNote(blob, contextKey, sessionGen);
        if (outcome === "sent" || outcome === "persisted-terminal") return null;
        return outcome === "skipped" ? "This conversation can't take it now." : "Couldn't save the recording.";
    } catch {
        return "Couldn't save the recording.";
    }
}

function Composer({
    client,
    state,
    drafts,
    draftReloadTick,
    reloadDraft,
    sendingConvos,
    draftRevisions,
    sentHistory,
}: {
    client: MatronJournalClient;
    state: ClientState;
    drafts: DraftStore;
    draftReloadTick: number;
    reloadDraft: (conversationId: string) => void;
    sendingConvos: React.RefObject<Set<string>>;
    draftRevisions: React.RefObject<Map<string, number>>;
    sentHistory: SentMessageHistory;
}): React.ReactElement {
    const [body, setBody] = useState("");
    // The voice-note path reads the draft from a callback that outlives renders.
    const bodyRef = useRef(body);
    bodyRef.current = body;
    const [highlighted, setHighlighted] = useState<number | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [nonDurable, setNonDurable] = useState(false);
    const store = useMemo(() => makeRecentFoldersStore(state.session), [state.session]);
    const [dismissedSeq, setDismissedSeq] = useState(0);
    const textarea = useRef<HTMLTextAreaElement>(null);
    // Sized from the value, not from input events: a draft restored on a conversation switch (or
    // on mount) opens at its full height, the same as it was while being typed.
    useAutoGrow(textarea, body);
    const fileInput = useRef<HTMLInputElement>(null);
    const convoId = state.selectedConversationId;
    const convoIdRef = useRef(convoId);
    convoIdRef.current = convoId;
    const prevConvoIdRef = useRef(convoId);
    const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const draftTimerConvoRef = useRef<string | undefined>(undefined);
    const suggestions: PaletteSuggestion[] = [
        ...argSuggestions(body, CLAUDE_BRIDGE_COMMANDS, state.sessionStatus).map((argument): PaletteSuggestion => ({
            kind: "argument",
            argument,
        })),
        ...folderSuggestions(body, store).map((path): PaletteSuggestion => ({ kind: "folder", path })),
    ];
    const commands = filterCommands(CLAUDE_BRIDGE_COMMANDS, body);
    const open = body !== dismissed && (suggestions.length > 0 || (isCommandMode(body) && commands.length > 0));

    // A finished voice note goes to the conversation it was recorded in. The typed draft goes with
    // it as its caption, so the agent gets both in one turn — unless a text send of it is already
    // in flight. Like the send button, the draft clears as the send starts (the promise below
    // settles only after the upload) and comes back if the voice note couldn't be saved.
    const onVoiceRecorded = (blob: Blob, { contextKey: capturedConvo, sessionGen }: VoiceRecordingContext): void => {
        const caption =
            convoIdRef.current === capturedConvo && !sendingConvos.current.has(capturedConvo)
                ? bodyRef.current.trim()
                : "";
        if (caption) {
            // The caption leaves the field now, so it joins sent history now (ending any walk) rather
            // than after the upload: a failed note puts it back in the field anyway.
            sentHistory.record(caption, capturedConvo);
            clearSentDraftRef.current(capturedConvo, draftRevisions.current.get(capturedConvo) ?? 0);
        }
        const failed = (): void => {
            if (caption) restoreDraftRef.current(capturedConvo, caption);
            voice.reportSendFailure("Couldn't save the recording — try again.");
        };
        void client
            .sendVoiceNote(blob, capturedConvo, sessionGen, caption || undefined)
            .then((outcome) => {
                if (outcome !== "sent" && outcome !== "persisted-terminal") failed();
            })
            .catch(failed);
    };
    const deliverVoiceNoteAway = (blob: Blob, context: VoiceRecordingContext): Promise<string | null> =>
        sendVoiceNoteAway(client, blob, context);
    // The note outlives this composer: it keeps recording across conversation switches and pages,
    // and one finished while no composer is mounted goes out on its own, the draft left in place.
    const voiceConversation = state.conversations.find((conversation) => conversation.id === convoId);
    const voice = useVoiceRecorder({
        contextKey: convoId,
        client,
        onRecorded: onVoiceRecorded,
        kind: "conversation",
        title: voiceConversation ? displayTitle(voiceConversation) : "this conversation",
        deliverAway: deliverVoiceNoteAway,
    });
    const { voiceState } = voice;

    // Mirror the store's canonical per-convo durability flag into React state, but only for the
    // currently-selected conversation — a late async persist/clear for A must not clobber B's badge.
    const syncDurability = useCallback(
        (cid: string) => {
            if (convoIdRef.current === cid) setNonDurable(drafts.durability(cid) === "non-durable");
        },
        [drafts],
    );
    const cancelDraftDebounce = useCallback(() => {
        if (draftTimerRef.current) {
            clearTimeout(draftTimerRef.current);
            draftTimerRef.current = undefined;
        }
        draftTimerConvoRef.current = undefined;
    }, []);
    // Cancel the pending debounce, but if it belonged to a DIFFERENT conversation than `keepCid`
    // (a cross-convo late send: switch to B + type while A's send is in flight), flush that convo
    // first so it isn't stranded. Never flush `keepCid`'s own timer — the caller is about to
    // clear/persist it explicitly, and force-persisting a just-sent draft here would make it
    // resurrect after a clear-failure (final-review round-3).
    const cancelDebounceKeeping = useCallback(
        (keepCid: string) => {
            const pendingCid = draftTimerConvoRef.current;
            cancelDraftDebounce();
            if (pendingCid && pendingCid !== keepCid) {
                drafts.persist(pendingCid);
                syncDurability(pendingCid);
            }
        },
        [cancelDraftDebounce, drafts, syncDurability],
    );
    const flushDraft = useCallback(() => {
        cancelDraftDebounce();
        const cid = prevConvoIdRef.current;
        if (cid) {
            drafts.persist(cid);
            syncDurability(cid);
        }
    }, [cancelDraftDebounce, drafts, syncDurability]);

    const setBodyDraft = useCallback(
        (next: string) => {
            // Any edit — typing, a palette pick, a restored draft — ends a sent-message walk.
            sentHistory.endRecall();
            setBody(next);
            const cid = convoIdRef.current;
            if (!cid) return;
            draftRevisions.current.set(cid, (draftRevisions.current.get(cid) ?? 0) + 1);
            drafts.setDraft(cid, next);
            if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
            draftTimerConvoRef.current = cid;
            draftTimerRef.current = setTimeout(() => {
                drafts.persist(cid);
                syncDurability(cid);
                draftTimerRef.current = undefined;
                draftTimerConvoRef.current = undefined;
            }, 250);
        },
        [draftRevisions, drafts, syncDurability, sentHistory],
    );

    useEffect(() => {
        const onVis = (): void => {
            if (document.visibilityState === "hidden") flushDraft();
        };
        window.addEventListener("pagehide", flushDraft);
        document.addEventListener("visibilitychange", onVis);
        return () => {
            window.removeEventListener("pagehide", flushDraft);
            document.removeEventListener("visibilitychange", onVis);
            flushDraft();
        };
    }, [flushDraft]);

    useLayoutEffect(() => {
        const prev = prevConvoIdRef.current;
        if (prev && prev !== convoId) flushDraft();
        const { text, ok } = convoId ? drafts.read(convoId) : { text: "", ok: true };
        setBody(ok ? text : "");
        setDismissed(null);
        setHighlighted(null);
        // A recalled sent line is shown but never written to the draft store, so the real draft
        // is what loads here; just drop the walk.
        sentHistory.endRecall();
        // Sync the badge FROM the store for the newly-selected convo — never a blind reset, so a
        // still-non-durable convo keeps its warning across switch-away/back (and a clear-failure flag surfaces).
        setNonDurable(convoId ? drafts.durability(convoId) === "non-durable" : false);
        prevConvoIdRef.current = convoId;
    }, [convoId, draftReloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

    const selectCommand = (command: BotCommand): void => {
        setBodyDraft(applyCommand(command.trigger));
        setHighlighted(null);
        textarea.current?.focus();
    };
    // Tab and Enter pick the row at `index`. A status frame can shorten the argument list under a
    // held highlight, so a row that is no longer there picks nothing (and Enter then sends).
    const pickRow = (index: number): boolean => {
        if (suggestions.length > 0) {
            if (!suggestions[index]) return false;
            selectSuggestion(suggestions[index]);
        } else {
            if (!commands[index]) return false;
            selectCommand(commands[index]);
        }
        return true;
    };
    // A folder completes the line, so the palette closes on it; an argument leaves a space after
    // it, and the palette goes on to offer whatever the command still accepts.
    const selectSuggestion = (suggestion: PaletteSuggestion): void => {
        if (suggestion.kind === "folder") {
            const nextBody = applyFolder(body, suggestion.path);
            setBodyDraft(nextBody);
            setDismissed(nextBody);
        } else {
            setBodyDraft(applyArgument(body, suggestion.argument.value));
        }
        setHighlighted(null);
        textarea.current?.focus();
    };
    // After a send took the draft (a text message, or a voice note carrying it as caption): clear it,
    // unless the user edited it during the send.
    const clearSentDraft = (cid: string, submittedRevision: number): void => {
        // Cancel cid's own pending timer without persisting (we clear/persist it below), but
        // flush any pending timer owned by another convo the user switched to during the send.
        cancelDebounceKeeping(cid);
        const draftUnchanged = (draftRevisions.current.get(cid) ?? 0) === submittedRevision;
        if (draftUnchanged) drafts.clear(cid);
        else drafts.persist(cid);
        syncDurability(cid);
        reloadDraft(cid);
        if (draftUnchanged && convoIdRef.current === cid) {
            setBody("");
            // The send glyph unmounts once the body is empty; keep focus in the composer.
            textarea.current?.focus();
            setDismissed(null);
            if (textarea.current) textarea.current.style.height = "auto";
        }
    };
    const clearSentDraftRef = useRef(clearSentDraft);
    clearSentDraftRef.current = clearSentDraft;
    // Puts back a draft a failed send took — unless the user has typed something new since.
    const restoreDraft = (cid: string, text: string): void => {
        if (drafts.read(cid).text.trim()) return;
        if (convoIdRef.current === cid) {
            setBodyDraft(text);
            return;
        }
        drafts.setDraft(cid, text);
        drafts.persist(cid);
        syncDurability(cid);
    };
    const restoreDraftRef = useRef(restoreDraft);
    restoreDraftRef.current = restoreDraft;
    // Terminal-style recall of this conversation's sent messages. A recalled line is only
    // shown — not written to the draft store — so the stored draft stays the real one, and
    // leaving mid-walk can't save a recalled line as the draft. Editing it makes it the draft.
    const showRecalled = (text: string | undefined): void => {
        if (text === undefined) return;
        setBody(text);
        setHighlighted(null);
        setDismissed(null);
        resizeAfterRecall.current = true;
    };
    const resizeAfterRecall = useRef(false);
    useLayoutEffect(() => {
        if (!resizeAfterRecall.current || !textarea.current) return;
        resizeAfterRecall.current = false;
        const node = textarea.current;
        node.style.height = "auto";
        node.style.height = `${Math.min(node.scrollHeight, 144)}px`;
        node.setSelectionRange(node.value.length, node.value.length);
    }, [body]);
    const tray = convoId ? (state.composerAttachments[convoId] ?? []) : [];
    // A send already uploading, or a file that can never upload, holds the send until it's done or removed.
    const trayHeld = tray.some((item) => item.unsendable || item.state === "queued" || item.state === "uploading");
    // With files in the tray the text leaves with them, as one turn: it rides on the first file.
    const sendStaged = async (cid: string, submitted: string): Promise<void> => {
        const staged = client.getSnapshot().composerAttachments[cid] ?? [];
        if (staged.some((item) => item.unsendable || item.state === "queued" || item.state === "uploading")) return;
        const caption = submitted.trim();
        const submittedRevision = draftRevisions.current.get(cid) ?? 0;
        sendingConvos.current.add(cid);
        // Like a voice note: the text leaves the field as the send starts (the uploads take a while)
        // and comes back if it didn't go out.
        if (caption) {
            sentHistory.record(caption, cid);
            clearSentDraft(cid, submittedRevision);
        }
        try {
            const { captionDelivered } = await client.sendStagedFiles(cid, caption);
            if (caption && !captionDelivered) restoreDraft(cid, submitted);
            const folder = captionDelivered ? recentFolderArgument(submitted) : undefined;
            if (folder) store.record(folder);
        } catch (error) {
            console.warn("matron: attachments not sent", error);
            if (caption) restoreDraft(cid, submitted);
        } finally {
            sendingConvos.current.delete(cid);
        }
    };
    const send = async (): Promise<void> => {
        const cid = convoIdRef.current;
        const submitted = body;
        if (!cid || sendingConvos.current.has(cid)) return;
        if ((client.getSnapshot().composerAttachments[cid] ?? []).length > 0) {
            await sendStaged(cid, submitted);
            return;
        }
        if (!submitted.trim()) return;
        const submittedRevision = draftRevisions.current.get(cid) ?? 0;
        sendingConvos.current.add(cid);
        try {
            if (await client.sendMessage(submitted, cid)) {
                sentHistory.record(submitted.trim(), cid);
                const folder = recentFolderArgument(submitted);
                if (folder) store.record(folder);
                clearSentDraft(cid, submittedRevision);
            }
        } catch (error) {
            console.warn("matron: message not queued (outbox write failed)", error);
        } finally {
            sendingConvos.current.delete(cid);
        }
    };
    return (
        <div className="mj_Composer" role="region" aria-label="Message composer" ref={voice.containerRef}>
            <div className="mj_Composer_wrapper">
                {state.connectionError && state.connectionErrorSeq !== dismissedSeq && (
                    <div className="mj_ConnectionError">
                        <span role="status">{state.connectionError}</span>
                        <button
                            className="mj_ConnectionError_dismiss"
                            type="button"
                            aria-label="Dismiss error"
                            title="Dismiss error"
                            onClick={() => setDismissedSeq(state.connectionErrorSeq)}
                        >
                            <CloseIcon />
                        </button>
                    </div>
                )}
                <VoiceErrorBanner recorder={voice} />
                {nonDurable && (
                    <div className="mj_DraftNonDurable" role="status">
                        Draft won't be saved — storage full
                    </div>
                )}
                {open && (
                    <SlashCommandPalette
                        commands={commands}
                        suggestions={suggestions}
                        highlighted={highlighted}
                        onHighlight={setHighlighted}
                        onSelectCommand={selectCommand}
                        onSelectSuggestion={selectSuggestion}
                    />
                )}
                {convoId && tray.length > 0 && (
                    <AttachmentTray
                        attachments={tray}
                        onRemove={(id) => {
                            client.removeStagedFile(convoId, id);
                            // The pressed button goes with its chip; keep keyboard focus in the composer.
                            textarea.current?.focus();
                        }}
                        onRetry={() => void send()}
                    />
                )}
                {voiceState === "recording" ? (
                    <VoiceRecordingBar recorder={voice} />
                ) : (
                    <div className="mj_ComposerRow">
                        {/* Mac composer: attach outside the field on the left; mic and the send glyph on the right. */}
                        <button
                            className="mj_ComposerControl mj_ComposerAttach"
                            title="Attach a file"
                            aria-label="Attach a file"
                            onClick={() => fileInput.current?.click()}
                        >
                            <PlusCircleIcon />
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            multiple
                            hidden
                            onChange={(event) => {
                                if (event.target.files) client.stageFiles([...event.target.files]);
                                event.target.value = "";
                            }}
                        />
                        <div className="mj_ComposerField" onClick={() => textarea.current?.focus()}>
                            <div className="mj_ComposerInput">
                                <textarea
                                    className="mj_ComposerInput_input"
                                    ref={textarea}
                                    rows={1}
                                    value={body}
                                    onBlur={flushDraft}
                                    onChange={(event) => {
                                        const nextBody = event.target.value;
                                        setBodyDraft(nextBody);
                                        setHighlighted(null);
                                        if (dismissed !== null && nextBody !== dismissed) setDismissed(null);
                                        event.target.style.height = "auto";
                                        // Mac composer: one 32px line, growing to eight (144px).
                                        event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
                                    }}
                                    onKeyDown={(event) => {
                                        if (isImeComposing(event)) return;
                                        // An active walk owns Up/Down outright: a recalled one-word
                                        // command opens the palette, and letting it take the arrows
                                        // would trap the walk there. Otherwise the palette's arrows
                                        // come first, and Up starts a walk only from an empty field
                                        // (in a draft it moves the caret).
                                        // Plain arrows only: with a modifier they keep their usual
                                        // caret and selection meaning (the desktop app's moveUp:/moveDown:).
                                        const plainArrow =
                                            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                                            !event.shiftKey &&
                                            !event.altKey &&
                                            !event.metaKey &&
                                            !event.ctrlKey;
                                        if (convoId && plainArrow) {
                                            const walking = sentHistory.isNavigating;
                                            if (event.key === "ArrowUp" && (walking || (!open && body === ""))) {
                                                event.preventDefault();
                                                showRecalled(sentHistory.recallOlder(convoId, body));
                                                return;
                                            }
                                            if (event.key === "ArrowDown" && walking) {
                                                event.preventDefault();
                                                showRecalled(sentHistory.recallNewer(convoId));
                                                return;
                                            }
                                        }
                                        if (open) {
                                            const count = suggestions.length || commands.length;
                                            if (event.key === "ArrowDown") {
                                                event.preventDefault();
                                                setHighlighted((current) =>
                                                    current === null ? 0 : (current + 1) % count,
                                                );
                                                return;
                                            }
                                            if (event.key === "ArrowUp") {
                                                event.preventDefault();
                                                setHighlighted((current) =>
                                                    current === null ? count - 1 : (current - 1 + count) % count,
                                                );
                                                return;
                                            }
                                            if (event.key === "Tab") {
                                                event.preventDefault();
                                                pickRow(highlighted ?? 0);
                                                return;
                                            }
                                            if (event.key === "Escape") {
                                                event.preventDefault();
                                                setDismissed(body);
                                                setHighlighted(null);
                                                return;
                                            }
                                            if (
                                                event.key === "Enter" &&
                                                !event.shiftKey &&
                                                highlighted !== null &&
                                                pickRow(highlighted)
                                            ) {
                                                event.preventDefault();
                                                return;
                                            }
                                        }
                                        if (isSendKey(event)) {
                                            event.preventDefault();
                                            void send();
                                        }
                                    }}
                                    onPaste={(event) => {
                                        const files = [...event.clipboardData.files];
                                        if (files.length > 0) {
                                            // preventDefault() marks this paste as consumed; the upload
                                            // modal's document-level paste listener (mounted synchronously by
                                            // stageFiles under React 19's discrete flush) checks
                                            // event.defaultPrevented and skips it, so the file stages once.
                                            // stopPropagation() is kept as defense-in-depth but is not the
                                            // load-bearing guard (it does not reliably stop a listener that is
                                            // registered mid-dispatch at document).
                                            event.preventDefault();
                                            event.stopPropagation();
                                            client.stageFiles(files);
                                        }
                                    }}
                                    placeholder={
                                        state.connection === "online"
                                            ? "Message…"
                                            : "Messages will send when reconnected"
                                    }
                                    aria-label="Message your agent"
                                    aria-describedby="mj-composer-hint"
                                    role="combobox"
                                    aria-expanded={open}
                                    aria-controls={SLASH_LISTBOX_ID}
                                    aria-activedescendant={highlighted !== null ? slashRowId(highlighted) : undefined}
                                />
                            </div>
                        </div>
                        <VoiceMicButton recorder={voice} className="mj_ComposerControl mj_ComposerMic" />
                        {/* Mac: the send glyph (arrow.up.circle.fill) appears only once there is
                            something to send — text, or a file in the tray. */}
                        {(body.trim() || tray.length > 0) && (
                            <button
                                className="mj_ComposerSend"
                                type="button"
                                disabled={trayHeld}
                                onClick={() => void send()}
                                aria-label="Send message"
                            >
                                <ArrowUpCircleIcon />
                            </button>
                        )}
                    </div>
                )}
                {/* The old hint row's instructions, kept for assistive tech only (the Mac shows none). */}
                <span id="mj-composer-hint" className="mj_ScreenReaderOnly">
                    / commands · shift+enter for newline
                </span>
            </div>
        </div>
    );
}

/**
 * The files waiting above the composer between attaching and sending: a thumbnail for an image, a
 * named chip for anything else, each with a remove button. While a send uploads them each shows
 * its progress; one that failed says why and offers a retry, which sends again with the text.
 */
function AttachmentTray({
    attachments,
    onRemove,
    onRetry,
}: {
    attachments: ComposerAttachment[];
    onRemove: (id: string) => void;
    onRetry: () => void;
}): React.ReactElement {
    // A failed send says so out loud too: the chip's label changes, but a label change isn't announced.
    const failure = attachments.find((item) => item.state === "failed" && !item.unsendable);
    return (
        <>
            <div className="mj_AttachmentTray" role="list" aria-label="Attachments">
                {attachments.map((attachment) => (
                    <StagedAttachmentChip
                        key={attachment.id}
                        attachment={attachment}
                        onRemove={() => onRemove(attachment.id)}
                        onRetry={onRetry}
                    />
                ))}
            </div>
            <span className="mj_AttachmentTray_status" role="status">
                {failure ? `${failure.file.name} was not sent: ${failure.error ?? "upload failed"}` : ""}
            </span>
        </>
    );
}

function StagedAttachmentChip({
    attachment,
    onRemove,
    onRetry,
}: {
    attachment: ComposerAttachment;
    onRemove: () => void;
    onRetry: () => void;
}): React.ReactElement {
    const { file, state } = attachment;
    const isImage = file.type.startsWith("image/") && !attachment.unsendable;
    const [previewUrl, setPreviewUrl] = useState<string>();
    useEffect(() => {
        if (!isImage || typeof URL.createObjectURL !== "function") return undefined;
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [file, isImage]);
    const busy = state === "queued" || state === "uploading";
    // A failed image shows as a named chip, so the reason it failed is on screen, not only in a tooltip.
    const thumbnail = isImage && state !== "failed" ? previewUrl : undefined;
    const percent = Math.round(Math.min(Math.max(attachment.progress ?? 0, 0), 1) * 100);
    const size = formatBytes(file.size) ?? "";
    const status =
        state === "uploading"
            ? `uploading, ${percent} percent`
            : state === "queued"
              ? "waiting to upload"
              : state === "failed"
                ? `not sent: ${attachment.error ?? "upload failed"}`
                : undefined;
    const KindIcon = FILE_KIND_ICON[fileKindFromMime(file.type)];
    return (
        <div
            role="listitem"
            className={[
                "mj_StagedAttachment",
                thumbnail ? "mj_StagedAttachment_image" : "mj_StagedAttachment_file",
                `mj_StagedAttachment_${state}`,
            ].join(" ")}
            aria-label={[`${isImage ? "Image" : "File"} attachment, ${file.name}, ${size}`, status]
                .filter(Boolean)
                .join(", ")}
            title={attachment.error ? `${file.name}: ${attachment.error}` : file.name}
        >
            {thumbnail ? (
                <img className="mj_StagedAttachment_thumb" src={thumbnail} alt="" />
            ) : (
                <>
                    <KindIcon className="mj_StagedAttachment_icon" aria-hidden />
                    <span className="mj_StagedAttachment_meta">
                        <span className="mj_StagedAttachment_name">{file.name}</span>
                        <span className="mj_StagedAttachment_detail">
                            {state === "failed" ? (attachment.error ?? "Upload failed") : size}
                        </span>
                    </span>
                </>
            )}
            {busy && (
                <span className="mj_StagedAttachment_progress" aria-hidden="true">
                    <span className="mj_StagedAttachment_progressFill" style={{ width: `${percent}%` }} />
                </span>
            )}
            {state === "failed" && !attachment.unsendable && (
                <button
                    type="button"
                    className="mj_StagedAttachment_retry"
                    aria-label={`Retry sending ${file.name}`}
                    title="Retry"
                    onClick={onRetry}
                >
                    <RefreshIcon aria-hidden />
                </button>
            )}
            {!busy && (
                <button
                    type="button"
                    className="mj_StagedAttachment_remove"
                    aria-label={`Remove ${file.name}`}
                    title="Remove"
                    onClick={onRemove}
                >
                    <CloseIcon aria-hidden />
                </button>
            )}
        </div>
    );
}

function EventSourceSheet({
    event,
    opener,
    onClose,
}: {
    event: JournalEvent;
    opener: HTMLElement | null;
    onClose: () => void;
}): React.ReactElement {
    const sheetRef = useRef<HTMLDivElement>(null);
    const doneRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        doneRef.current?.focus();
        return () => {
            if (opener?.isConnected) opener.focus();
        };
    }, [opener]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                onClose();
                return;
            }
            if (event.key !== "Tab") return;
            const focusable = [...(sheetRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (
                event.shiftKey &&
                (document.activeElement === first || !sheetRef.current?.contains(document.activeElement))
            ) {
                event.preventDefault();
                last.focus();
            } else if (
                !event.shiftKey &&
                (document.activeElement === last || !sheetRef.current?.contains(document.activeElement))
            ) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const json = JSON.stringify(event, null, 2);
    // §10.8: the footer states the payload size so a clipped body is detectable. Byte size
    // (not code-unit length) — matches what the operator would see on the wire.
    const byteSize = typeof Blob === "function" ? new Blob([json]).size : json.length;
    return (
        <div
            className="mj_EventSource_scrim"
            role="dialog"
            aria-modal="true"
            aria-label="Event source"
            onClick={onClose}
        >
            <div ref={sheetRef} className="mj_EventSource" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                <header className="mj_EventSource_header">
                    <CodeBracketsIcon className="mj_EventSource_headerIcon" aria-hidden />
                    <h2>Event source</h2>
                    <span className="mj_EventSource_typeChip">{event.type}</span>
                    <span className="mj_EventSource_headerSpacer" />
                    <button
                        type="button"
                        className="mj_EventSource_close"
                        aria-label="Close"
                        title="Close"
                        onClick={onClose}
                    >
                        <CloseIcon aria-hidden />
                    </button>
                </header>
                <div className="mj_EventSource_body">
                    {/* §10.8: lift the scalar fields the operator scans for OUT of the blob into a
                        labelled meta grid, so reading JSON to find a timestamp isn't the task. */}
                    <div className="mj_EventSource_meta">
                        <span className="mj_EventSource_metaCell">
                            <span className="mj_EventSource_metaLabel">seq</span>
                            <span className="mj_EventSource_metaValue">{event.seq}</span>
                        </span>
                        <span className="mj_EventSource_metaCell">
                            <span className="mj_EventSource_metaLabel">sender</span>
                            <span className="mj_EventSource_metaValue">{event.sender}</span>
                        </span>
                        <span className="mj_EventSource_metaCell">
                            <span className="mj_EventSource_metaLabel">timestamp</span>
                            <span className="mj_EventSource_metaValue">{formatEventTimestamp(event.ts)}</span>
                        </span>
                        <span className="mj_EventSource_metaCell">
                            <span className="mj_EventSource_metaLabel">convo</span>
                            <span
                                className="mj_EventSource_metaValue mj_EventSource_metaValue_trunc"
                                title={event.convo_id}
                            >
                                {event.convo_id}
                            </span>
                        </span>
                    </div>
                    <pre className="mj_EventSource_json">{json}</pre>
                </div>
                <div className="mj_EventSource_footer">
                    <span className="mj_EventSource_note">Read-only · {byteSize} bytes</span>
                    <button type="button" className="mj_Btn mj_EventSource_secondary" onClick={onClose}>
                        Close
                    </button>
                    <button
                        type="button"
                        className="mj_Btn mj_Btn_primary mj_EventSource_copy"
                        ref={doneRef}
                        onClick={() => void copyText(json)}
                    >
                        <ClipboardIcon aria-hidden />
                        Copy JSON
                    </button>
                </div>
            </div>
        </div>
    );
}

// Event-source timestamp cell — a clock time with milliseconds (HH:MM:SS.mmm), lifted out
// of the JSON blob per §10.8. Local time; the raw epoch stays visible in the blob below.
function formatEventTimestamp(ts: number): string {
    if (!Number.isFinite(ts)) return String(ts);
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return String(ts);
    const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function SubagentStrip({
    client,
    state,
    mode,
}: {
    client: MatronJournalClient;
    state: ClientState;
    mode: "parent" | "child";
}): React.ReactElement | null {
    const selected = state.conversations.find((conversation) => conversation.id === state.selectedConversationId);
    const siblingOrChildParentId = mode === "parent" ? state.selectedConversationId : selected?.parent_convo_id;
    const siblingOrChildren = childrenOf(state.conversations, siblingOrChildParentId);
    // in child view the escape names its destination — look up the parent conversation.
    const parent =
        mode === "child" && selected?.parent_convo_id
            ? state.conversations.find((conversation) => conversation.id === selected.parent_convo_id)
            : undefined;
    if (siblingOrChildren.length === 0 && !parent) return null;

    const runningFirst = (conversations: Conversation[]): Conversation[] => [
        ...conversations.filter((conversation) => conversation.session_state === "running"),
        ...conversations.filter((conversation) => conversation.session_state !== "running"),
    ];
    const ordered = runningFirst(siblingOrChildren);
    // What the slot beside the chat shows: the pill of a subagent open there is marked current.
    const sidePane = chatSidePane(state);
    return (
        // §10.11: a non-scrolling row — the back chip + hairline stay PINNED while only the
        // pill run scrolls, so the escape never scrolls off among many siblings.
        <div className="mj_SubagentStrip" role="group" aria-label="Subagents">
            {parent && (
                <>
                    <button
                        className="mj_SubagentBack"
                        type="button"
                        title="Back to the parent conversation (Esc)"
                        aria-label={`Back to ${conversationTitle(parent)}`}
                        onClick={() => void client.selectConversation(parent.id)}
                    >
                        <ChevronLeftIcon className="mj_SubagentBack_icon" aria-hidden="true" />
                        <span className="mj_SubagentBack_name">
                            <TaggedTitle conversation={parent} agents={state.agents} />
                        </span>
                    </button>
                    <span className="mj_SubagentStrip_hairline" aria-hidden="true" />
                </>
            )}
            {ordered.length > 0 && (
                <div className="mj_SubagentStrip_run" role="list">
                    <span className="mj_SubagentStripLabel" aria-hidden="true">
                        Subagents
                    </span>
                    {ordered.map((child) => {
                        const isCurrent = mode === "child" && child.id === state.selectedConversationId;
                        // In a parent, the subagent open in the pane beside it.
                        const inPane =
                            mode === "parent" && sidePane?.kind === "subchat" && sidePane.childId === child.id;
                        const isRunning = child.session_state === "running";
                        const outcomeStatus = accessibleOutcome(classifyOutcome(child));
                        const className = [
                            "mj_SubagentPill",
                            !isRunning && "mj_SubagentPill_finished",
                            (isCurrent || inPane) && "mj_SubagentPill_current",
                        ]
                            .filter(Boolean)
                            .join(" ");
                        return (
                            <div key={child.id} role="listitem" className="mj_SubagentPill_wrapper">
                                <button
                                    className={className}
                                    aria-label={`Open subagent ${conversationTitle(child)}, ${outcomeStatus}`}
                                    aria-current={isCurrent || inPane ? "true" : undefined}
                                    disabled={isCurrent}
                                    onClick={() => client.openSubChat(child.id)}
                                >
                                    <WorkerMark conversation={child} className="mj_WorkerMark mj_SubagentPill_icon" />
                                    <OutcomeGlyph conversation={child} className="mj_SubagentPill_icon" />
                                    <span className="mj_SubagentPill_name">
                                        <TaggedTitle conversation={child} agents={state.agents} />
                                    </span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/**
 * Surface A — the pinned conversation summary (design 2026-08). A running,
 * server-generated digest rendered as a bullet list, pinned between the SubagentStrip
 * and the Timeline. The bar IS the expand control; the body is aria-live="polite" so a
 * server refresh is announced without stealing the operator's focus. The feed landed in
 * Pinned summary: the owning bridge publishes its rolling digest to conversations.summary and
 * the call site in SignedInApp parses it via `conversationSummary()`. A conversation with
 * no digest passes null and this renders nothing at all.
 *
 * Reachable-state note: the app only ever passes null or a "ready" summary with at least
 * one bullet. The empty-state box and the "updating" shimmer have no data source on the
 * wire (design §5.4) and are exercised by unit tests only.
 */
export type ConversationSummary = {
    /** Condensed bullet lines (each rendered with a • marker). Server-clamped to 20. */
    bullets: string[];
    /** "ready" shows the list; "updating" dims it under a refresh shimmer. */
    state?: "ready" | "updating";
    /** Epoch-ms of the last server refresh. The relative label is derived client-side
        (repo wire convention: timestamps are epoch-ms, relative text is recomputed on the
        client — a server-formatted "Nm ago" string would freeze when the feed does not
        republish an unchanged summary every minute). */
    updatedAtMs?: number;
};

/** Bullets longer than this clamp to 2 lines with an in-place Expand control. */
const PINNED_SUMMARY_CLAMP_CHARS = 160;

export function PinnedSummary({ summary }: { summary: ConversationSummary | null }): React.ReactElement | null {
    const bodyId = useId();
    const [collapsed, setCollapsed] = useState(false);
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>());
    // Ticks once a minute so the "updated Nm ago" label advances on an idle page instead of
    // freezing at render time (the label is derived client-side from updatedAtMs).
    const now = useMinuteClock();
    // Per-bullet Expand is keyed by array index, so a refresh that reorders bullets must clear
    // it, or an unrelated new bullet inherits the old expansion. The call site additionally keys
    // <PinnedSummary> by conversation id, so collapsed/expanded reset on a conversation switch.
    const bulletsKey = JSON.stringify(summary?.bullets ?? []);
    useEffect(() => {
        setExpanded(new Set<number>());
    }, [bulletsKey]);
    if (!summary) {
        return null;
    }
    const bullets = summary.bullets;
    const isEmpty = bullets.length === 0;
    const isUpdating = summary.state === "updating";
    const lead = bullets[0] ?? "";
    const toggleExpanded = (index: number): void => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };
    return (
        <div className="mj_PinnedSummary" data-collapsed={collapsed ? "true" : "false"}>
            <button
                type="button"
                className="mj_PinnedSummary_bar"
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                onClick={() => setCollapsed((value) => !value)}
            >
                <PinIcon className="mj_PinnedSummary_pin" aria-hidden />
                <span className="mj_PinnedSummary_label">Summary</span>
                <span className="mj_PinnedSummary_lead">{collapsed ? lead : ""}</span>
                {summary.updatedAtMs !== undefined ? (
                    <span className="mj_PinnedSummary_meta">updated {formatSampleAge(now - summary.updatedAtMs)}</span>
                ) : null}
                <ChevronDownIcon className="mj_PinnedSummary_chev" aria-hidden />
            </button>
            {!collapsed && (
                <div className="mj_PinnedSummary_body" id={bodyId} aria-live="polite">
                    {isEmpty ? (
                        <div className="mj_PinnedSummary_empty">
                            No summary yet. It appears once the conversation has enough to digest.
                        </div>
                    ) : (
                        <>
                            {isUpdating && <div className="mj_PinnedSummary_shimmer" aria-hidden />}
                            <div className={`mj_PinnedSummary_scroll${isUpdating ? " mj_PinnedSummary_updating" : ""}`}>
                                <ul className="mj_PinnedSummary_list">
                                    {bullets.map((text, index) => {
                                        const clampable = text.length > PINNED_SUMMARY_CLAMP_CHARS;
                                        const open = expanded.has(index);
                                        return (
                                            <li key={index} className="mj_PinnedSummary_item">
                                                <span
                                                    className={
                                                        clampable && !open ? "mj_PinnedSummary_item_clamp" : undefined
                                                    }
                                                >
                                                    {text}
                                                </span>
                                                {clampable && (
                                                    <button
                                                        type="button"
                                                        className="mj_PinnedSummary_more"
                                                        onClick={() => toggleExpanded(index)}
                                                    >
                                                        {open ? "Show less" : "Expand"}
                                                    </button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

// The subagent pane's rows: what the chat's own transcript shows for a read-only subagent, with
// the same folding (answered prompts, released queue items, decided permissions, restated item
// cards, spawn and chat-request outcomes).
function subChatTranscript(events: JournalEvent[], client: MatronJournalClient): SubChatRow[] {
    const queuedReleasePromptSeqs = new Set<number>();
    const legacyQueuePromptSeqs = new Set<number>();
    const permissionRequestSeqs = new Set<number>();
    const answeredPromptReplies = new Map<string, { choice?: string }>();
    const spawnOutcomes = new Map<string, EventPayload>();
    const releasedActions = new Map<string, "send" | "cancel">();
    for (const event of events) {
        if (event.type === "permission_request") permissionRequestSeqs.add(event.seq);
        else if (event.type === "prompt") {
            if (asString(event.payload.kind) === "queued_release") queuedReleasePromptSeqs.add(event.seq);
            else if (isLegacyQueuePrompt(event)) legacyQueuePromptSeqs.add(event.seq);
        } else if (event.type === "prompt_reply") {
            const targetSeq = asNumber(event.payload.target_seq, Number.NaN);
            if (Number.isSafeInteger(targetSeq) && targetSeq >= 0) {
                const choice = asString(event.payload.choice, asString(event.payload.label)) || undefined;
                answeredPromptReplies.set(`${event.convo_id}:${targetSeq}`, { choice });
            }
            const action = asString(event.payload.action);
            if (
                asString(event.payload.kind) === "queued_release" &&
                Array.isArray(event.payload.released) &&
                (action === "send" || action === "cancel")
            ) {
                for (const releasedId of event.payload.released) {
                    const itemId = asString(releasedId);
                    if (itemId) releasedActions.set(itemId, action);
                }
            }
        } else if (event.type === "spawn_outcome" && typeof event.payload.request_id === "string") {
            spawnOutcomes.set(event.payload.request_id, event.payload);
        }
    }
    const itemCards = foldItemCards(events);
    const agentChatResolutions = readAgentChatResolutions(events);
    const coordinatorDecisions = readCoordinatorDecisions(events);
    const resolvedAction = (itemId: string): "send" | "cancel" | undefined => releasedActions.get(itemId);
    return events
        .filter(
            (event) =>
                !isFoldedTranscriptEvent(event, {
                    queuedReleasePromptSeqs,
                    legacyQueuePromptSeqs,
                    permissionRequestSeqs,
                    itemCards,
                }),
        )
        .map((event) => ({
            event,
            content: (
                <EventContent
                    client={client}
                    event={event}
                    answeredPromptReplies={answeredPromptReplies}
                    spawnOutcomes={spawnOutcomes}
                    agentChatResolutions={agentChatResolutions}
                    coordinatorDecisions={coordinatorDecisions}
                    itemCards={itemCards}
                    isReadOnly
                    resolvedAction={resolvedAction}
                />
            ),
        }));
}

function SignedInApp({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const leftPanel = useLeftPanelResize();
    const [dragActive, setDragActive] = useState(state.dragActive);
    const [draftReloadTicks, setDraftReloadTicks] = useState<Record<string, number>>({});
    const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
    // Meter count drives the usage collapse threshold: the synthetic ctx bar, each non-blank
    // account limit, and the host cpu/ram meters. >4 (host cpu/ram present) needs the wider
    // pane before the 3-column grid renders inline instead of collapsing to the popover.
    // Derived from the SAME builder the headers render, and filtered by the same non-blank
    // label rule UsageCluster applies, so the count cannot disagree with what is on screen —
    // counting status.limits alone undercounts by two now that the host meters are
    // synthesized from status.vitals rather than carried inside limits[].
    const meterCount = buildUsageMeters(
        state.sessionStatus,
        state.sessionStatus?.limits?.filter((limit) => limit.label.trim()),
        state.hostVitals,
    ).filter((meter) => meter.label.trim()).length;
    const collapse = useAdaptiveHeader(bodyEl, meterCount);
    // The command palette puts the caret back in the composer on screen after a pick.
    const appContent = useRef<HTMLDivElement>(null);
    // Desktop notifications and the unread count in the title / app badge, while signed in.
    useEffect(() => notificationsFor(client).start(), [client]);
    // A voice note outlives every page but not the signed-in app: leaving it releases the microphone.
    useEffect(() => () => voiceNoteSessionFor(client).reset(), [client]);
    const voiceNoteBarVisible = useVoiceNoteBarVisible(client);
    const openVoiceNoteTarget = useCallback(
        (kind: string, contextKey: string): void => {
            if (kind === "conversation") void client.selectConversation(contextKey);
            else if (kind === "item") client.openTrackerItem(Number(contextKey));
        },
        [client],
    );
    // Settings, the tracker and the other sheets load in their own chunks: fetch them once the
    // first screen is up, so they open instantly later.
    useEffect(() => preloadDeferredUi(), []);
    const drafts = useMemo(() => makeDraftStore(state.session), [state.session]);
    const sendingConvos = useRef<Set<string>>(new Set());
    const draftRevisions = useRef<Map<string, number>>(new Map());
    // Sent-message recall is per account, like the drafts; it lives for the page session only.
    const sentHistory = useMemo(() => new SentMessageHistory(), [state.session]); // eslint-disable-line react-hooks/exhaustive-deps

    // Markdown attachment preview: a side panel to the right of the conversation or item.
    const markdownPreview = useMarkdownPreviewPanel();
    const closeMarkdownPreview = markdownPreview.close;
    // It belongs to the view it was opened from: moving to another conversation or item closes it.
    useEffect(() => {
        closeMarkdownPreview();
    }, [
        state.selectedConversationId,
        state.trackerView?.open,
        state.trackerView?.view,
        state.trackerView?.selectedItemId,
        closeMarkdownPreview,
    ]);

    const isFileDrag = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types).includes("Files");
    const selected = client.selectedConversation();
    const childMode = selected != null && isSubChat(selected);

    // §10.11.E: Escape unwinds ONE layer at a time, outermost-last. Inner layers (source
    // viewer, upload/new-session modals, open menus) own their own Escape and close first;
    // this handler is the INNERMOST rung — when nothing else is open and you are inside a
    // subagent, Escape returns to the parent (the same action as the back chip). The
    // DOM-presence guard enforces "one layer per press": while any overlay is still mounted
    // (it hasn't unmounted yet during this same keydown), this rung defers to it.
    const parentId = childMode ? selected?.parent_convo_id : undefined;
    const hasParent = Boolean(
        parentId && parentId !== selected?.id && state.conversations.some((c) => c.id === parentId),
    );
    useEffect(() => {
        if (!hasParent || !parentId) return undefined;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            // Any inner overlay still mounted → it owns this press; defer.
            if (
                document.querySelector(
                    ".mj_MediaViewer_scrim, .mj_MediaBrowser_scrim, .mj_EventSource_scrim, .mj_UploadConfirm_scrim, .mj_NewSessionSheet, .mj_SettingsScrim, .mj_EventRowMenu, .mj_ConversationMenu, .mj_HeaderMenu, .mj_MdPreview, [role='menu']",
                )
            ) {
                return;
            }
            event.preventDefault();
            void client.selectConversation(parentId);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [hasParent, parentId, client]);

    useGoToNumberShortcut(client, true);
    // Ctrl/⌘F finds in the conversation on screen; with none open the browser keeps the key.
    useFindInChatShortcut(client, Boolean(state.selectedConversationId) && !state.trackerView?.open);

    const reloadDraft = useCallback(
        (conversationId: string) =>
            setDraftReloadTicks((ticks) => ({ ...ticks, [conversationId]: (ticks[conversationId] ?? 0) + 1 })),
        [],
    );
    // ⌘K: the slash palette, for a conversation with a composer on screen (Mac: the chat view's).
    const [paletteOpen, setPaletteOpen] = useState(false);
    const composerConvo =
        state.selectedConversationId && !state.trackerView?.open && !childMode ? state.selectedConversationId : null;
    useEffect(() => setPaletteOpen(false), [composerConvo]);
    useAppShortcuts(client, {
        enabled: true,
        onCommandPalette: composerConvo ? () => setPaletteOpen((open) => !open) : undefined,
    });
    // A pick replaces the draft with the command, ready for arguments, as the composer's own palette does.
    const pickCommand = (command: BotCommand): void => {
        setPaletteOpen(false);
        if (!composerConvo) return;
        const text = applyCommand(command.trigger);
        sentHistory.endRecall();
        draftRevisions.current.set(composerConvo, (draftRevisions.current.get(composerConvo) ?? 0) + 1);
        drafts.setDraft(composerConvo, text);
        drafts.persist(composerConvo);
        reloadDraft(composerConvo);
        requestAnimationFrame(() => {
            const input = appContent.current?.querySelector<HTMLTextAreaElement>(".mj_ComposerInput_input");
            input?.focus();
            input?.setSelectionRange(text.length, text.length);
        });
    };

    // The one pane beside the chat: a subagent (opened from a Subtask line or a subagent pill) or
    // the chat's Tasks & decisions. Only the subagent pane measures the chat area; the Tasks pane
    // decides from its own media query whether it covers the chat.
    const sidePane = chatSidePane(state);
    const chatAreaRef = useRef<HTMLDivElement>(null);
    const chatArea = useChatArea(appContent, chatAreaRef, sidePane?.kind === "subchat");

    return (
        <MarkdownPreviewContext.Provider value={markdownPreview.context}>
            <div className="mj_App_wrapper">
                <ConnectionBanner client={client} state={state} />
                <div ref={appContent} className="mj_App">
                    <ConversationList client={client} state={state} width={leftPanel.width} />
                    <div
                        className="mj_ResizeHandle mj_ResizeHandle--horizontal"
                        data-id="lp-resizer"
                        onPointerDown={leftPanel.onPointerDown}
                    >
                        <div />
                    </div>
                    <div
                        ref={chatAreaRef}
                        // Covered by the subagent pane, the chat stays mounted but out of reach.
                        inert={sidePane?.kind === "subchat" && paneCoversChat(chatArea)}
                        className={`mj_ChatView_wrapper ${mainSurfaceOpen(state, !isElectronRuntime()) ? "" : "mj_Chat_mobileHidden"}${voiceNoteBarVisible ? " mj_ChatView_wrapper_voiceNote" : ""}`}
                    >
                        {state.trackerView?.open ? (
                            <TrackerPane client={client} state={state} />
                        ) : state.opsView?.open ? (
                            <OpsPane client={client} state={state} />
                        ) : state.filesView?.open && !isElectronRuntime() ? (
                            <FilesPane client={client} state={state} />
                        ) : state.selectedConversationId ? (
                            <div
                                className={`mj_ChatView${dragActive ? " mj_ChatView_dragActive" : ""}`}
                                onDragOver={(event) => {
                                    if (!isFileDrag(event)) return;
                                    event.preventDefault();
                                    setDragActive(true);
                                }}
                                onDrop={(event) => {
                                    if (!isFileDrag(event)) return;
                                    event.preventDefault();
                                    setDragActive(false);
                                    if (childMode) return;
                                    const files = [...event.dataTransfer.files];
                                    if (files.length > 0) client.stageFiles(files);
                                }}
                                onDragLeave={(event) => {
                                    const nextTarget = event.relatedTarget;
                                    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                                    setDragActive(false);
                                }}
                                onDragEnd={() => setDragActive(false)}
                            >
                                {dragActive && (
                                    <div className="mj_DragOverlay" aria-hidden="true">
                                        Drop files to attach
                                    </div>
                                )}
                                <div ref={setBodyEl} className="mj_ChatView_body" data-layout="bubble">
                                    {childMode ? (
                                        <SubChatHeader client={client} state={state} collapse={collapse} />
                                    ) : (
                                        <ChatHeader client={client} state={state} collapse={collapse} />
                                    )}
                                    {!childMode && (
                                        <CompactNudge
                                            key={state.selectedConversationId}
                                            context={state.sessionStatus?.context}
                                            send={(command) =>
                                                client.sendMessage(command, state.selectedConversationId)
                                            }
                                        />
                                    )}
                                    <SubagentStrip
                                        client={client}
                                        state={state}
                                        mode={childMode ? "child" : "parent"}
                                    />
                                    {/* Pinned conversation summary, fed by the bridge's rolling digest. Renders
                                        nothing when the conversation has no digest. The conversation-id key
                                        remounts on a room switch so disclosure state never carries across. */}
                                    <PinnedSummary
                                        key={`summary:${state.selectedConversationId ?? "no-convo"}`}
                                        summary={conversationSummary(
                                            state.conversations.find(
                                                (conversation) => conversation.id === state.selectedConversationId,
                                            ),
                                        )}
                                    />
                                    {state.chatSearch?.conversationId === state.selectedConversationId && (
                                        <FindInChatBar client={client} search={state.chatSearch} />
                                    )}
                                    <Timeline client={client} state={state} isReadOnly={childMode} />
                                    {childMode ? (
                                        <ReadOnlyHint />
                                    ) : (
                                        <Composer
                                            client={client}
                                            state={state}
                                            drafts={drafts}
                                            draftReloadTick={draftReloadTicks[state.selectedConversationId] ?? 0}
                                            reloadDraft={reloadDraft}
                                            sendingConvos={sendingConvos}
                                            draftRevisions={draftRevisions}
                                            sentHistory={sentHistory}
                                        />
                                    )}
                                </div>
                            </div>
                        ) : (
                            <main className="mj_HomePage mj_HomePage_default">
                                <div className="mj_HomePage_default_wrapper">
                                    <img src={matronLogo} alt={state.config.brand || "Matron"} />
                                    <h1>Welcome to {state.config.brand || "Matron"}</h1>
                                </div>
                            </main>
                        )}
                        <VoiceNoteBar client={client} onOpen={openVoiceNoteTarget} />
                    </div>
                    {/* One slot beside the chat, decided by chatSidePane: never both panes at once. */}
                    {sidePane?.kind === "subchat" ? (
                        <SubChatPane
                            key={sidePane.parentId}
                            client={client}
                            conversations={state.conversations}
                            parentId={sidePane.parentId}
                            childId={sidePane.childId}
                            area={chatArea}
                            transcript={subChatTranscript}
                        />
                    ) : sidePane?.kind === "tasks" && state.chatTasks ? (
                        <ChatTasksPane
                            client={client}
                            pane={state.chatTasks}
                            convoId={sidePane.convoId}
                            conversations={state.conversations}
                        />
                    ) : null}
                    {markdownPreview.target ? (
                        <MarkdownPreviewPanel
                            client={client}
                            target={markdownPreview.target}
                            onClose={markdownPreview.close}
                        />
                    ) : null}
                </div>
                {state.goToNumberOpen && <GoToNumberDialog client={client} />}
                {paletteOpen && composerConvo && (
                    <CommandPalette onPick={pickCommand} onClose={() => setPaletteOpen(false)} />
                )}
            </div>
        </MarkdownPreviewContext.Provider>
    );
}

export function MatronApp({ client }: { client: MatronJournalClient }): React.ReactElement {
    const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
    if (state.phase === "loading")
        return (
            <div className="mj_App_splash mj_Loading">
                <img src={matronLogo} alt="Matron" />
            </div>
        );
    if (state.phase === "signed-out") return <LoginScreen client={client} state={state} />;
    return <SignedInApp client={client} state={state} />;
}
