/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, {
    type FormEvent,
    type RefObject,
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

import matronLogo from "../../res/matron-logo-simple.svg";
import { INITIAL_SGR_STATE, parseAnsi, stripLeadingSgrFragment } from "./ansi";
import {
    BROWSER_MEMORY_SAFETY_MAX_BYTES,
    errorMessage,
    type MatronJournalClient,
    PREFERENCES_UNAVAILABLE_ERROR,
} from "./client";
import { copyText } from "./clipboard";
import { type DraftStore, makeDraftStore } from "./composer-drafts";
import { effectiveUnread } from "./conversation-flags";
import { type RowContextMenu, useRowContextMenu } from "./context-menu";
import {
    ArchiveIcon,
    AttachmentIcon,
    CheckIcon,
    ChevronDownIcon,
    ChevronLeftIcon,
    ClipboardIcon,
    CloseIcon,
    CodeBracketsIcon,
    CompactIcon,
    ComposeIcon,
    FileEditIcon,
    KebabIcon,
    MarkdownIcon,
    MarkAllReadIcon,
    MarkReadIcon,
    MarkUnreadIcon,
    MicOnIcon,
    PinIcon,
    SearchIcon,
    SendIcon,
    SettingsIcon,
    StopIcon,
    SystemThemeIcon,
    LightThemeIcon,
    DarkThemeIcon,
    StarFilledIcon,
    StarIcon,
    TrashIcon,
    UnarchiveIcon,
} from "./icons";
import { createLongPressController, type LongPressController } from "./longPress";
import { MarkdownBody, markdownToPlainText } from "./markdown";
import { getSnapshot, nextThemePref, setTheme, subscribe } from "./theme";
import {
    applyCommand,
    applyFolder,
    type BotCommand,
    CLAUDE_BRIDGE_COMMANDS,
    filterCommands,
    folderSuggestions,
    isCommandMode,
    makeRecentFoldersStore,
    recentFolderArgument,
} from "./slash-palette";
import {
    compactTokens,
    normalizePercent,
    resetDisplay,
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
    childrenOf,
    childSidebarPlacement,
    type ClientState,
    type Conversation,
    conversationTitle,
    type DeviceDTO,
    displaySender,
    type EventPayload,
    isNearBottom,
    type JournalEvent,
    type PendingMessage,
    type RecentFolder,
    rendersAsTopLevelRow,
    isSubChat,
    type SessionStatus,
    type StagedUploadItem,
    type StagedUploads,
    type ToolStreamState,
} from "./types";

const LEFT_PANEL_SIZE_KEY = "mx_lhs_size";
const LEFT_PANEL_DEFAULT_WIDTH = 350;
const LEFT_PANEL_MIN_WIDTH = 224;

function clampLeftPanelWidth(width: number, containerWidth: number): number {
    return Math.min(Math.max(width, LEFT_PANEL_MIN_WIDTH), Math.max(LEFT_PANEL_MIN_WIDTH, containerWidth / 2));
}

function initialLeftPanelWidth(): number {
    let storedWidth = Number.NaN;
    try {
        storedWidth = Number.parseInt(window.localStorage.getItem(LEFT_PANEL_SIZE_KEY) ?? "", 10);
    } catch {
        // Storage can be unavailable; the default width remains usable.
    }
    return clampLeftPanelWidth(
        Number.isFinite(storedWidth) && storedWidth >= LEFT_PANEL_MIN_WIDTH ? storedWidth : LEFT_PANEL_DEFAULT_WIDTH,
        document.documentElement.clientWidth,
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
            const nextWidth = clampLeftPanelWidth(widthRef.current, document.documentElement.clientWidth);
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
            const nextWidth = clampLeftPanelWidth(moveEvent.clientX - containerLeft, container.clientWidth);
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

export function ThemeToggle(): React.ReactElement {
    const preference = useSyncExternalStore(subscribe, getSnapshot);
    const label = preference === null ? "System" : preference === "light" ? "Light" : "Dark";
    const icon =
        preference === null ? <SystemThemeIcon /> : preference === "light" ? <LightThemeIcon /> : <DarkThemeIcon />;

    return (
        <button
            className="mj_IconButton"
            type="button"
            aria-label={`Theme: ${label}`}
            title={`Theme: ${label}`}
            onClick={() => setTheme(nextThemePref(preference))}
        >
            {icon}
        </button>
    );
}

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

// EXPORTED: the render callsite uses it, and unit tests import it directly to inject `now`.
// `formatTime` stays private; only this helper needs the test seam.
export function formatRelativeDay(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp)) return ""; // Non-finite → no throw, empty string.
    const then = new Date(timestamp);
    if (Number.isNaN(then.getTime())) return ""; // Invalid Date → Intl.format would throw; bail.
    const today = new Date(now);
    const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayMs = 86_400_000;
    const daysAgo = Math.round((startOf(today) - startOf(then)) / dayMs);
    if (daysAgo === 0) return formatTime(timestamp); // Today (including same-day minor-future skew) → clock.
    if (daysAgo >= 1 && daysAgo <= 6) {
        return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(then);
    }
    // Older than six days or a genuinely future calendar day falls through to a dated label.
    const sameYear = then.getFullYear() === today.getFullYear();
    return new Intl.DateTimeFormat(
        undefined,
        sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
    ).format(then);
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
    const dateStr = new Intl.DateTimeFormat(
        undefined,
        sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" },
    ).format(then);
    let word: string | undefined;
    if (daysAgo === 0) word = "Today";
    else if (daysAgo === 1) word = "Yesterday";
    else if (daysAgo >= 2 && daysAgo <= 6) word = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(then);
    return word ? `${word} · ${dateStr}` : dateStr;
}

function formatBytes(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function LoginScreen({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const [server, setServer] = useState(client.suggestedServer());
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(state.connectionError);

    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
            await client.login(server, username, password);
        } catch (loginError) {
            setError(errorMessage(loginError));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mx_AuthPage" style={{ background: "var(--cpd-color-bg-canvas-raised)" }}>
            <div className="mx_AuthPage_modal mx_AuthPage_modal_withBlur" style={{ position: "relative" }}>
                <div
                    className="mx_AuthPage_modalBlur"
                    style={{
                        position: "absolute",
                        inset: 0,
                        filter: "blur(40px)",
                        background: "var(--cpd-color-bg-canvas-raised)",
                    }}
                />
                <main
                    className="mx_AuthPage_modalContent"
                    style={{ display: "flex", zIndex: 1, borderRadius: "inherit" }}
                    tabIndex={-1}
                    aria-live="polite"
                >
                    <div className="mx_AuthHeader">
                        <aside className="mx_AuthHeaderLogo">
                            <img src={matronLogo} alt={state.config.brand || "Matron"} />
                        </aside>
                    </div>
                    <div className="mx_AuthBody">
                        <h1>Sign in</h1>
                        <form onSubmit={(event) => void submit(event)}>
                            <div className="mx_Field mx_Field_labelAlwaysTopLeft">
                                <input
                                    id="mj_LoginForm_server"
                                    type="text"
                                    inputMode="url"
                                    value={server}
                                    onChange={(event) => setServer(event.target.value)}
                                    placeholder="https://chat.example.com"
                                    autoComplete="url"
                                    required
                                    autoFocus={!server}
                                />
                                <label htmlFor="mj_LoginForm_server">Journal server</label>
                            </div>
                            <div className="mx_Field">
                                <input
                                    id="mj_LoginForm_username"
                                    type="text"
                                    value={username}
                                    onChange={(event) => setUsername(event.target.value)}
                                    placeholder=" "
                                    autoComplete="username"
                                    required
                                    autoFocus={Boolean(server)}
                                />
                                <label htmlFor="mj_LoginForm_username">Username</label>
                            </div>
                            <div className="mx_Field">
                                <input
                                    id="mj_LoginForm_password"
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    placeholder=" "
                                    autoComplete="current-password"
                                    required
                                />
                                <label htmlFor="mj_LoginForm_password">Password</label>
                            </div>
                            {error && (
                                <div className="mx_ErrorMessage mj_Error" role="alert">
                                    {error}
                                </div>
                            )}
                            <button className="mx_Login_submit" type="submit" disabled={busy}>
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
                    </div>
                </main>
            </div>
        </div>
    );
}

type SheetState =
    | { step: "loading-agents" }
    | { step: "agents-error" }
    | { step: "agents"; agents: DeviceDTO[] }
    | {
          step: "folders";
          agent: DeviceDTO;
          foldersRequestId: number;
          folders?: RecentFolder[];
          foldersError?: string;
      }
    | { step: "starting"; agent: DeviceDTO }
    | { step: "uncertain" }
    | { step: "error"; agent: DeviceDTO; message: string };

function agentName(agent: DeviceDTO): string {
    return agent.name?.trim() || `Agent ${agent.device_id}`;
}

function agentStatus(agent: DeviceDTO): string {
    if (agent.connected) return "Connected";
    if (agent.last_seen_at === undefined) return "Offline · last seen unknown";
    const timestamp = agent.last_seen_at < 1_000_000_000_000 ? agent.last_seen_at * 1000 : agent.last_seen_at;
    return `Offline · last seen ${new Date(timestamp).toLocaleString()}`;
}

export function NewSessionSheet({
    client,
    onClose,
}: {
    client: MatronJournalClient;
    onClose: () => void;
}): React.ReactElement {
    const [sheetState, setSheetState] = useState<SheetState>({ step: "loading-agents" });
    const [workdir, setWorkdir] = useState("");
    const [browserTools, setBrowserTools] = useState(false);
    const [showBack, setShowBack] = useState(false);
    const sheetStateRef = useRef(sheetState);
    const agentsRef = useRef<DeviceDTO[]>([]);
    const agentsRequestIdRef = useRef(0);
    const foldersRequestIdRef = useRef(0);
    const startingRef = useRef(false);
    const mountedRef = useRef(false);
    const dismissedRef = useRef(false);

    const transition = useCallback((next: SheetState): void => {
        sheetStateRef.current = next;
        setSheetState(next);
    }, []);

    const loadFolders = useCallback(
        (agent: DeviceDTO, backAvailable: boolean): void => {
            const foldersRequestId = ++foldersRequestIdRef.current;
            setShowBack(backAvailable);
            transition({ step: "folders", agent, foldersRequestId });
            void client.recentFolders(agent.device_id).then(
                (folders) => {
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
                    transition({ ...current, folders });
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
                    transition({ ...current, folders: [], foldersError: "Couldn't load recent folders." });
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
                const connectedAgents = agents.filter((agent) => agent.connected);
                if (connectedAgents.length === 1) {
                    loadFolders(connectedAgents[0], false);
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
        startingRef.current = true;
        transition({ step: "starting", agent });
        const outcome = await client.startSessionRpc(agent.device_id, path, browser);
        if (!mountedRef.current || dismissedRef.current) return;
        if (outcome.kind === "created") {
            dismissedRef.current = true;
            onClose();
            void client.selectConversation(outcome.convoId, { fromRpcCreate: true });
            return;
        }
        if (outcome.kind === "uncertain") {
            transition({ step: "uncertain" });
            return;
        }
        startingRef.current = false;
        transition({ step: "error", agent, message: outcome.message });
    };

    const folderState = sheetState.step === "folders" ? sheetState : undefined;

    return (
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-new-session-title">
            <div className="mj_UploadConfirm mj_NewSessionSheet">
                <div className="mj_NewSessionSheet_head">
                    <h2 className="mj_UploadConfirm_title" id="mj-new-session-title">
                        New session
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
                                {sheetState.agents.map((agent) => (
                                    <button
                                        key={agent.device_id}
                                        type="button"
                                        role="listitem"
                                        disabled={!agent.connected}
                                        onClick={() => loadFolders(agent, true)}
                                    >
                                        <strong>{agentName(agent)}</strong>
                                        <span>{agentStatus(agent)}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {folderState && (
                    <>
                        <p>Start on {agentName(folderState.agent)}</p>
                        {folderState.folders === undefined ? (
                            <div role="status">
                                <span className="mj_Spinner" aria-hidden="true" /> Loading recent folders…
                            </div>
                        ) : (
                            folderState.folders.length > 0 && (
                                <div role="list" aria-label="Recent folders">
                                    {folderState.folders.map((folder) => (
                                        <button
                                            key={folder.path}
                                            type="button"
                                            role="listitem"
                                            onClick={() => {
                                                setWorkdir(folder.path);
                                                void start(folderState.agent, folder.path, browserTools);
                                            }}
                                        >
                                            {folder.path}
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

function ConversationList({
    client,
    state,
    width,
}: {
    client: MatronJournalClient;
    state: ClientState;
    width: number;
}): React.ReactElement {
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState<"active" | "favorites" | "archived">("active");
    const [accountOpen, setAccountOpen] = useState(false);
    const [newSessionOpen, setNewSessionOpen] = useState(false);
    const [roomMenu, setRoomMenu] = useState<{ conversationId: string; left: number; top: number }>();
    const roomMenuRef = useRef(roomMenu);
    const roomMenuElementRef = useRef<HTMLDivElement>(null);
    const roomMenuOpenerRef = useRef<HTMLElement | null>(null);
    const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const longPressTargetRef = useRef<{ conversationId: string; row: HTMLButtonElement } | undefined>(undefined);
    const longPressFiredRef = useRef(false);
    const longPressScrollCleanupRef = useRef<() => void>(() => undefined);
    const openRoomMenuRef = useRef<(conversationId: string, left: number, top: number, opener: HTMLElement) => void>(
        () => undefined,
    );
    const longPressControllerRef = useRef<LongPressController | undefined>(undefined);
    const [, forceDayTick] = useReducer((n) => n + 1, 0);

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

    roomMenuRef.current = roomMenu;
    openRoomMenuRef.current = (conversationId, left, top, opener): void => {
        setAccountOpen(false);
        setNewSessionOpen(false);
        roomMenuOpenerRef.current = opener;
        setRoomMenu({ conversationId, left, top });
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
                openRoomMenuRef.current(target.conversationId, rect.right, rect.top, target.row);
            },
        });
    }

    const closeRoomMenu = useCallback((restoreFocus = false): void => {
        if (!roomMenuRef.current) return;
        setRoomMenu(undefined);
        if (restoreFocus) roomMenuOpenerRef.current?.focus();
    }, []);

    // After a menu ACTION (mark-read/archive/unarchive) the focused menuitem unmounts, and
    // archive/unarchive also remove the originating row — so restoring to the opener only works
    // when it survives. Defer past the state-change re-render, then focus the opener if it's still
    // connected (mark-read), else the always-present search input, so keyboard focus never falls
    // through to document.body.
    const restoreFocusAfterMenuAction = useCallback((): void => {
        const opener = roomMenuOpenerRef.current;
        requestAnimationFrame(() => {
            if (opener && opener.isConnected) opener.focus();
            else document.getElementById("room-list-search-input")?.focus();
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
        },
        [],
    );

    useEffect(() => {
        if (!roomMenu) return;
        const onPointerDown = (event: PointerEvent): void => {
            if (!roomMenuRef.current || roomMenuElementRef.current?.contains(event.target as Node)) return;
            closeRoomMenu();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (roomMenuRef.current && event.key === "Escape") closeRoomMenu(true);
        };
        const onScroll = (): void => {
            if (roomMenuRef.current) closeRoomMenu();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [Boolean(roomMenu), closeRoomMenu]);

    useLayoutEffect(() => {
        if (!roomMenu || !roomMenuElementRef.current) return;
        const rect = roomMenuElementRef.current.getBoundingClientRect();
        const left = Math.max(8, Math.min(roomMenu.left, window.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(roomMenu.top, window.innerHeight - rect.height - 8));
        if (left !== roomMenu.left || top !== roomMenu.top) {
            setRoomMenu({ ...roomMenu, left, top });
        }
    }, [roomMenu]);

    useLayoutEffect(() => {
        if (!roomMenu) return;
        roomMenuElementRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [roomMenu]);
    // #536: ONE canonical index feeds BOTH sidebar paths here (top-level fallback + nested
    // splice) AND the client-side selection/unread/mark-all consumers, so "rendered" and
    // "selectable/counted" can never diverge. rendersAsTopLevelRow: a non-child always
    // renders top-level; a child renders top-level only when childSidebarPlacement says so
    // (orphan → always; parent exists → running-only, and then only when it can't nest).
    const sidebarIndex = buildSidebarIndex(state.conversations, state.archivedIds);
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
    const activeAll = conversations.filter((conversation) => !state.archivedIds.has(conversation.id));
    const active = [
        ...activeAll.filter((conversation) => state.pinnedIds.has(conversation.id)),
        ...activeAll.filter((conversation) => !state.pinnedIds.has(conversation.id)),
    ];
    // #532: the Archived tab lists EVERY archived conversation flat — including an archived
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
    // the tab badge matches the flat Archived list they render into (#532).
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
    const menuConversation = roomMenu
        ? state.conversations.find((conversation) => conversation.id === roomMenu.conversationId)
        : undefined;

    useEffect(() => {
        if (roomMenu && !menuConversation) closeRoomMenu();
    }, [roomMenu, menuConversation, closeRoomMenu]);

    const openAtElement = (conversationId: string, anchor: HTMLElement, opener: HTMLElement = anchor): void => {
        const rect = anchor.getBoundingClientRect();
        openRoomMenuRef.current(conversationId, rect.right, rect.bottom, opener);
    };

    const renderNow = Date.now();
    const renderConversation = (
        conversation: ClientState["conversations"][number],
        isSubagent = false,
    ): React.ReactElement => {
        const selected = state.selectedConversationId === conversation.id;
        const overrideUnread = state.unreadOverrideIds.has(conversation.id) && conversation.unread_count === 0;
        const unread = effectiveUnread(conversation, state.unreadOverrideIds);
        const name = conversationTitle(conversation);
        const running = conversation.session_state === "running";
        const relativeTimestamp = formatRelativeDay(conversation.last_ts ?? conversation.created_at, renderNow);
        return (
            <div className="mj_RoomListItem_wrapper" role="listitem" key={conversation.id}>
                <button
                    className={`mj_RoomListItem${selected ? " mj_RoomListItem_selected" : ""}${isSubagent ? " mj_RoomListItem_sub" : ""}`}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    aria-label={`Open ${isSubagent ? "subagent" : "room"} ${name}, last activity ${relativeTimestamp}${overrideUnread ? ", marked unread" : ""}`}
                    onClick={(event) => {
                        if (longPressFiredRef.current) {
                            longPressFiredRef.current = false;
                            event.preventDefault();
                            event.stopPropagation();
                            return;
                        }
                        void client.selectConversation(conversation.id);
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        const keyboardTriggered = event.clientX === 0 && event.clientY === 0;
                        if (keyboardTriggered) {
                            const trigger = menuTriggerRefs.current.get(conversation.id);
                            openAtElement(conversation.id, trigger ?? event.currentTarget, event.currentTarget);
                            return;
                        }
                        openRoomMenuRef.current(conversation.id, event.clientX, event.clientY, event.currentTarget);
                    }}
                    onPointerDown={(event) => {
                        if (event.pointerType !== "touch") return;
                        longPressTargetRef.current = { conversationId: conversation.id, row: event.currentTarget };
                        longPressFiredRef.current = false;
                        longPressControllerRef.current?.onPointerDown(event.clientX, event.clientY);
                        listenForLongPressScroll();
                    }}
                    onPointerMove={(event) => {
                        if (event.pointerType !== "touch") return;
                        longPressControllerRef.current?.onPointerMove(event.clientX, event.clientY);
                        if (!longPressControllerRef.current?.isPending && !longPressControllerRef.current?.didFire) {
                            longPressScrollCleanupRef.current();
                        }
                    }}
                    onPointerUp={(event) => {
                        if (event.pointerType !== "touch") return;
                        longPressControllerRef.current?.onPointerUp();
                        longPressTargetRef.current = undefined;
                        longPressScrollCleanupRef.current();
                    }}
                    onPointerCancel={(event) => {
                        if (event.pointerType === "touch") cancelLongPress();
                    }}
                >
                    {/* §118 leading-glyph precedence. Subagent rows: spinner while running,
                        else an idle dot (they aren't pinned/favourited). Parent rows keep the
                        shipped pin-or-status behaviour (star renders separately before the meta). */}
                    {isSubagent ? (
                        running ? (
                            <span className="mj_Spinner mj_RoomListSubSpinner" aria-hidden="true" />
                        ) : (
                            <span className="mj_RoomListStatus mj_RoomListStatus_idle" aria-hidden="true" />
                        )
                    ) : state.pinnedIds.has(conversation.id) ? (
                        <span className="mj_RoomListPinGlyph">
                            <PinIcon aria-hidden />
                        </span>
                    ) : (
                        <span
                            className={`mj_RoomListStatus mj_RoomListStatus_${
                                conversation.session_state === "running" ? "running" : "idle"
                            }`}
                            aria-hidden="true"
                        />
                    )}
                    <span className={`mj_RoomListText${unread ? " mj_RoomListText_unread" : ""}`}>
                        <span className="mj_RoomListName" title={name} data-testid="room-name">
                            {isSubagent && (
                                <span className="mj_RoomListSubArrow" aria-hidden="true">
                                    ↳{" "}
                                </span>
                            )}
                            {name}
                        </span>
                        <span className="mj_RoomListPreview" title={conversation.snippet}>
                            {conversation.snippet}
                        </span>
                    </span>
                    {state.favoriteIds.has(conversation.id) && (
                        <span className="mj_RoomListStarGlyph">
                            <StarFilledIcon aria-hidden />
                        </span>
                    )}
                    <span className="mj_RoomListMeta">
                        <span className="mj_RoomListTime">{relativeTimestamp}</span>
                        {conversation.unread_count > 0 ? (
                            <span className="mj_UnreadBadge" aria-label={`${conversation.unread_count} unread`}>
                                {conversation.unread_count}
                            </span>
                        ) : overrideUnread ? (
                            <span className="mj_UnreadDot" aria-hidden />
                        ) : null}
                    </span>
                </button>
                {/* The row menu opens via right-click / long-press for pointer + touch. This
                    trigger is invisible to mouse users (no hover reveal) but appears on
                    keyboard focus, so keyboard/AT users keep a discoverable, operable route. */}
                <button
                    className="mj_RoomItemMenu_trigger"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={roomMenu?.conversationId === conversation.id}
                    aria-label="Conversation options"
                    ref={(element) => {
                        if (element) menuTriggerRefs.current.set(conversation.id, element);
                        else menuTriggerRefs.current.delete(conversation.id);
                    }}
                    onClick={(event) => {
                        event.stopPropagation();
                        openAtElement(conversation.id, event.currentTarget);
                    }}
                >
                    <KebabIcon />
                </button>
            </div>
        );
    };

    return (
        <div
            className={`mx_LeftPanel_outerWrapper ${state.selectedConversationId ? "mj_Sidebar_mobileHidden" : ""}`}
            style={{ "--mj-left-panel-width": `${width}px` } as React.CSSProperties}
        >
            <div className="mx_LeftPanel_wrapper mx_LeftPanel_newRoomList">
                <div className="mx_LeftPanel_wrapper--user">
                    <div className="mx_LeftPanel mx_LeftPanel_newRoomList">
                        <div className="mx_LeftPanel_roomListContainer">
                            <nav className="mx_RoomListPanel" aria-label="Room list">
                                <header
                                    className="mj_RoomListHeader"
                                    aria-label="Room options"
                                    data-testid="room-list-header"
                                >
                                    <div className="mj_Wordmark">
                                        <img className="mj_WordmarkLogo" src={matronLogo} alt="" aria-hidden="true" />
                                        <h1 title={state.config?.brand || "Matron"}>
                                            {state.config?.brand || "Matron"}
                                        </h1>
                                    </div>
                                    <div className="mj_RoomListHeaderActions">
                                        <ThemeToggle />
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
                                            aria-label="Settings"
                                            onClick={() => {
                                                setNewSessionOpen(false);
                                                setAccountOpen((open) => !open);
                                            }}
                                        >
                                            <SettingsIcon />
                                        </button>
                                    </div>
                                </header>
                                {/* v5 sidebar.newSession: a full-width teal button in its own
                                    row below the wordmark — not a bare icon in the header. */}
                                <div className="mj_NewSessionRow">
                                    <button
                                        className="mj_NewSessionButton"
                                        type="button"
                                        aria-label="New conversation"
                                        title="Start a new session — runs /start"
                                        onClick={() => {
                                            setAccountOpen(false);
                                            closeRoomMenu();
                                            setNewSessionOpen(true);
                                        }}
                                    >
                                        <ComposeIcon />
                                        <span>New session</span>
                                    </button>
                                </div>
                                <div className="mj_RoomListTabs" role="group" aria-label="Filter conversations">
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
                                            className={`mj_RoomListTab${tab === key ? " mj_RoomListTab_active" : ""}`}
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
                                <div data-testid="room-list-search" className="mx_RoomListSearch" role="search">
                                    <label
                                        className="mx_RoomListSearch_inputWrapper mx_no_textinput"
                                        htmlFor="room-list-search-input"
                                    >
                                        <SearchIcon aria-hidden />
                                        <input
                                            id="room-list-search-input"
                                            className="mx_RoomListSearch_input"
                                            type="search"
                                            value={query}
                                            onChange={(event) => setQuery(event.target.value)}
                                            placeholder="Search"
                                            aria-label="Search"
                                            autoComplete="off"
                                        />
                                    </label>
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
                                <div
                                    className="mj_RoomList"
                                    data-testid="room-list"
                                    role="list"
                                    aria-label="Conversations"
                                >
                                    {/* #532: Active/Favorites render each parent row, then splice
                                        its NON-ARCHIVED subagent children in beneath (indented) —
                                        archiving a child removes it from these tabs. The Archived
                                        tab renders flat (archived parents + archived children as
                                        top-level rows), so an archived child stays discoverable +
                                        unarchivable regardless of its parent's state.
                                        #533/#536: children are TRANSIENT — a child nests here ONLY
                                        while running (subagents are one-shot; a done/idle child
                                        drops out of the sidebar but stays in state.conversations so
                                        the header pill strip still shows it when its parent is
                                        selected). The gate is childSidebarPlacement — the SAME
                                        predicate that builds the top-level list above — so the
                                        nested path and the fallback path stay in lock-step (a done
                                        child of an ARCHIVED parent can't leak in via either). The
                                        Archived tab is unaffected. */}
                                    {tab === "archived"
                                        ? visibleRows.map((conversation) => renderConversation(conversation, false))
                                        : visibleRows.flatMap((conversation) => [
                                              renderConversation(conversation, false),
                                              ...childrenOf(state.conversations, conversation.id)
                                                  .filter(
                                                      (child) =>
                                                          !state.archivedIds.has(child.id) &&
                                                          childSidebarPlacement(child, sidebarIndex) === "nested",
                                                  )
                                                  .map((child) => renderConversation(child, true)),
                                          ])}
                                    {tab === "active" && !hasAnyActive && archivedTotal === 0 && (
                                        <p className="mj_RoomListEmpty">Your agent conversations will appear here.</p>
                                    )}
                                    {tab === "active" && !hasAnyActive && archivedTotal > 0 && (
                                        <p className="mj_RoomListEmpty">No active conversations.</p>
                                    )}
                                    {tab === "active" && hasAnyActive && !visibleRows.length && (
                                        <p className="mj_RoomListEmpty">No conversations match your search.</p>
                                    )}
                                    {tab === "favorites" && !hasAnyFavorite && (
                                        <p className="mj_RoomListEmpty">No favorite conversations yet.</p>
                                    )}
                                    {tab === "favorites" && hasAnyFavorite && !visibleRows.length && (
                                        <p className="mj_RoomListEmpty">No favorites match your search.</p>
                                    )}
                                    {tab === "archived" && archivedTotal === 0 && (
                                        <p className="mj_RoomListEmpty">No archived conversations.</p>
                                    )}
                                    {tab === "archived" && archivedTotal > 0 && !visibleRows.length && (
                                        <p className="mj_RoomListEmpty">No archived conversations match your search.</p>
                                    )}
                                </div>
                            </nav>
                        </div>
                    </div>
                    <div className="mj_SidebarFooter">
                        <span className="mj_SidebarFooterAvatar" aria-hidden="true">
                            {(state.session?.username ?? "?").slice(0, 1)}
                        </span>
                        <span className="mj_SidebarFooterId" title={state.session?.username}>
                            {state.session?.username ?? "Signed out"}
                        </span>
                        <span className={`mj_SidebarFooterStatus mj_SidebarFooterStatus_${state.connection}`}>
                            <span className="mj_SidebarFooterDot" aria-hidden="true" />
                            {state.connection === "online"
                                ? "connected"
                                : state.connection === "connecting"
                                  ? "connecting…"
                                  : "offline"}
                        </span>
                    </div>
                </div>
                {accountOpen && (
                    <div className="mj_HeaderMenu mj_AccountMenu">
                        <strong>{state.session?.username}</strong>
                        <span>{state.session?.serverUrl}</span>
                        <button onClick={() => void client.logout()}>Sign out</button>
                    </div>
                )}
                {newSessionOpen && <NewSessionSheet client={client} onClose={() => setNewSessionOpen(false)} />}
                {roomMenu && menuConversation && (
                    <div
                        className="mj_HeaderMenu mj_RoomItemMenu"
                        role="menu"
                        ref={roomMenuElementRef}
                        style={{ position: "fixed", left: roomMenu.left, top: roomMenu.top }}
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
                                closeRoomMenu(true);
                            }
                        }}
                    >
                        {state.pinnedIds.has(menuConversation.id) ? (
                            <button
                                className="mj_RoomItemMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeRoomMenu();
                                    client.unpinConversation(menuConversation.id);
                                    restoreFocusAfterMenuAction();
                                }}
                            >
                                <PinIcon aria-hidden />
                                Unpin
                            </button>
                        ) : (
                            <button
                                className="mj_RoomItemMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeRoomMenu();
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
                                className="mj_RoomItemMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeRoomMenu();
                                    client.unfavoriteConversation(menuConversation.id);
                                    restoreFocusAfterMenuAction();
                                }}
                            >
                                <StarFilledIcon aria-hidden />
                                Remove from Favorites
                            </button>
                        ) : (
                            <button
                                className="mj_RoomItemMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeRoomMenu();
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
                                    className="mj_RoomItemMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closeRoomMenu();
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
                                    className="mj_RoomItemMenu_item"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closeRoomMenu();
                                        client.markConversationRead(menuConversation.id);
                                        restoreFocusAfterMenuAction();
                                    }}
                                >
                                    <MarkReadIcon aria-hidden />
                                    Mark as read
                                </button>
                            )}
                        {state.archivedIds.has(menuConversation.id) ? (
                            <button
                                className="mj_RoomItemMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeRoomMenu();
                                    client.unarchiveConversation(menuConversation.id);
                                    restoreFocusAfterMenuAction();
                                }}
                            >
                                <UnarchiveIcon aria-hidden />
                                Unarchive
                            </button>
                        ) : (
                            <button
                                className="mj_RoomItemMenu_item"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    closeRoomMenu();
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
        </div>
    );
}

export function useDismissablePopover(
    open: boolean,
    close: () => void,
    refs: { openerRef: RefObject<HTMLElement | null>; panelRef: RefObject<HTMLElement | null> },
): void {
    const { openerRef, panelRef } = refs;
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target as Node;
            if (!openerRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            close();
            openerRef.current?.focus();
        };
        const onScroll = (event: Event): void => {
            if (!panelRef.current?.contains(event.target as Node)) close();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [open, close, openerRef, panelRef]);
}

// Redesign-v4 pane-width bands (ResizeObserver on the chat pane, not viewport):
// >=640 full 2×2 usage grid (keep all four bars as long as they genuinely fit — the
// 2×2 is ~350px and clears a minimal title down to ~640); <640 collapse to a ctx+5h
// two-row stack + popover with all four. >=560 full subtitle + Compact; <560 subtitle →
// status dot + short model, title popover, Compact hidden.
const USAGE_COLLAPSE_PX = 640;
// #526: with host cpu/ram the grid grows to a 3rd column (~500px) — it needs a wider pane
// to render without crushing the title, so collapse earlier (to the ctx+5h popover, which
// still lists all six bars). Only the collapse WIDTH moves for the wide grid; the collapse
// BEHAVIOUR (ctx+5h stack + popover) is unchanged, preserving the tuned narrow experience.
const USAGE_COLLAPSE_WIDE_PX = 760;
const USAGE_WIDE_METER_COUNT = 4; // >4 meters ⇒ 3rd column ⇒ use the wide threshold
const TITLE_COLLAPSE_PX = 560;

export function useAdaptiveHeader(
    bodyEl: HTMLElement | null,
    meterCount = 0,
): {
    usageCollapsed: boolean;
    titleCollapsed: boolean;
} {
    const usageCollapsePx = meterCount > USAGE_WIDE_METER_COUNT ? USAGE_COLLAPSE_WIDE_PX : USAGE_COLLAPSE_PX;
    const [collapse, setCollapse] = useState({ usageCollapsed: false, titleCollapsed: false });
    const collapseRef = useRef(collapse);

    useEffect(() => {
        if (bodyEl == null || typeof ResizeObserver === "undefined") {
            if (collapseRef.current.usageCollapsed || collapseRef.current.titleCollapsed) {
                const expanded = { usageCollapsed: false, titleCollapsed: false };
                collapseRef.current = expanded;
                setCollapse(expanded);
            }
            return;
        }

        let latestWidth = 0;
        let frame: number | null = null;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            latestWidth = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                const usageCollapsed = latestWidth < usageCollapsePx;
                const titleCollapsed = latestWidth < TITLE_COLLAPSE_PX;
                if (
                    collapseRef.current.usageCollapsed !== usageCollapsed ||
                    collapseRef.current.titleCollapsed !== titleCollapsed
                ) {
                    const next = { usageCollapsed, titleCollapsed };
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
    }, [bodyEl, usageCollapsePx]);

    return collapse;
}

function useMinuteClock(now?: number): number {
    const [clockNow, setClockNow] = useState(Date.now);
    useEffect(() => {
        if (now !== undefined) return;
        const interval = window.setInterval(() => setClockNow(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, [now]);
    return now ?? clockNow;
}

// The usage meter leads with a synthetic "ctx" bar (context-window %), matching
// the v3/v4 mock where ctx is the first, emphasised meter; the rate limits follow.
function buildUsageMeters(
    status: SessionStatus | undefined,
    limits: SessionStatus["limits"] | undefined,
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
    if (limits?.length) meters.push(...limits);
    // Normalise to the design's column-first grid order (ctx/5h, fbl/model/wk, cpu/ram);
    // stable so any extra limits keep their relative order after the known ones.
    return meters
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
                    // Raw used/limit pair (ctx bar → e.g. 144k/200k). Only meters that carry
                    // both raw numbers render it; the pair is folded into aria-valuetext too.
                    const rawPair =
                        limit.used != null && limit.limit != null
                            ? `${compactTokens(limit.used)}/${compactTokens(limit.limit)}`
                            : undefined;
                    const accessibleLabel = usageAccessibleLabel(limit);
                    const valueText =
                        norm === null
                            ? "usage unknown"
                            : `${norm}% used${rawPair ? `, ${rawPair}` : ""}${reset ? `, resets ${reset}` : ""}`;
                    return (
                        <div
                            className={`mj_UsageRow${rawPair ? " mj_UsageRow_raw" : ""}`}
                            key={index}
                            title={reset ? `resets ${reset}` : undefined}
                        >
                            {/* Visible label is the short tag; the accessible name keeps the
                                full server-authored label so SR users know which limit it is. */}
                            <span className="mj_UsageLabel" aria-hidden="true">
                                {usageShortLabel(limit)}
                            </span>
                            <span
                                className="mj_UsageTrack"
                                role="progressbar"
                                aria-label={accessibleLabel}
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
                            {rawPair && (
                                <span className="mj_UsageRaw" aria-hidden="true">
                                    {rawPair}
                                </span>
                            )}
                            <span className={`mj_UsagePercent mj_UsagePercent_${level}`}>
                                {norm === null ? "—" : `${Math.round(norm)}%`}
                            </span>
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
            onMouseEnter={() => setHoverOpen(true)}
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
                onClick={() => setPinned((value) => !value)}
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

export function HeaderShell({
    mode,
    onBack,
    backLabel,
    title,
    titleGlyph,
    titleBadge,
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
    // Optional glyph before the title (child view: ↳) and a badge after it (SUBAGENT). §10.11
    // requires the header to name the SUBAGENT when inside one — never the parent.
    titleGlyph?: React.ReactNode;
    titleBadge?: React.ReactNode;
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

    // ctx is the first meter (context %); it stays visible when usage collapses.
    // Collapsed usage keeps two rows — ctx + the 5h (Session) limit — since the header
    // band has the height for two and one bar reads as too little (operator's call).
    const ctxMeter = limits?.length ? limits[0] : undefined;
    // 5h session limit: match the stable id first, fall back to the short-tag heuristic
    // for older/cached frames that lack ids.
    const sessionMeter = limits?.find(
        (meter) => meter.id === "session_5h" || (!meter.id && usageShortLabel(meter) === "5h"),
    );
    const collapsedMeters = ctxMeter ? (sessionMeter ? [ctxMeter, sessionMeter] : [ctxMeter]) : [];
    const worst = limits ? worstLimit(limits) : undefined;
    const worstNormalized = worst ? (normalizePercent(worst.percent) ?? 0) : undefined;
    const worstReset = worst ? resetDisplay(worst.resets_at, worst.resets, now, worst.resets_at_ms) : "";
    const usageLabel =
        worstNormalized === undefined
            ? "Usage — all metrics"
            : `Usage — worst limit ${Math.round(worstNormalized)}%${worstReset ? `, resets ${worstReset}` : ""}`;

    const controls = titleCollapsed && hideControlsWhenCompact ? null : rightControls;

    return (
        <header
            ref={headerRef}
            className={`mx_RoomHeader light-panel mj_ChatHeader${mode === "child" ? " mj_SubChatHeader" : ""}`}
            tabIndex={-1}
        >
            <button type="button" className="mj_BackButton" onClick={onBack} aria-label={backLabel}>
                <ChevronLeftIcon />
            </button>
            {titleCollapsed ? (
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
                            className="mx_RoomHeader_heading"
                            title={title}
                        >
                            {titleGlyph && (
                                <span className="mj_HeaderTitleGlyph" aria-hidden="true">
                                    {titleGlyph}
                                </span>
                            )}
                            <span className="mx_RoomHeader_truncated mx_lineClamp">{title}</span>
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
                    <div id={titleHeadingId} dir="auto" role="heading" aria-level={1} className="mx_RoomHeader_heading">
                        {titleGlyph && (
                            <span className="mj_HeaderTitleGlyph" aria-hidden="true">
                                {titleGlyph}
                            </span>
                        )}
                        <span className="mx_RoomHeader_truncated mx_lineClamp">{title}</span>
                        {titleBadge}
                    </div>
                    {hasSubtitle && <div className="mj_HeaderMeta">{subtitle}</div>}
                </div>
            )}
            <div className="mj_HeaderControls">
                {usageCollapsed && ctxMeter ? (
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
                    (Boolean(limits?.length) || Boolean(usageCollapsed && ctxMeter)) && (
                        <span className="mj_HeaderDivider" aria-hidden="true" />
                    )}
                {controls}
                {persistentControls}
            </div>
        </header>
    );
}

// Header "⋯" overflow: the selected conversation's actions (same set as the sidebar
// row menu), opened by click only (never hover — these mutate state).
function HeaderOverflowMenu({
    client,
    conversation,
    state,
}: {
    client: MatronJournalClient;
    conversation: Conversation;
    state: ClientState;
}): React.ReactElement {
    const [open, setOpen] = useState(false);
    const openerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismissablePopover(open, close, { openerRef, panelRef });
    useLayoutEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [open]);

    const id = conversation.id;
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
        requestAnimationFrame(() => {
            if (opener?.isConnected) opener.focus();
        });
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
                onClick={() => setOpen((current) => !current)}
            >
                <KebabIcon aria-hidden />
            </button>
            {open && (
                <div
                    className="mj_HeaderMenu mj_RoomItemMenu"
                    role="menu"
                    ref={panelRef}
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
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                            openerRef.current?.focus();
                        }
                    }}
                >
                    <button
                        className="mj_RoomItemMenu_item"
                        type="button"
                        role="menuitem"
                        onClick={() =>
                            act(() => (isPinned ? client.unpinConversation(id) : client.pinConversation(id)))
                        }
                    >
                        <PinIcon aria-hidden />
                        {isPinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                        className="mj_RoomItemMenu_item"
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
                            className="mj_RoomItemMenu_item"
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
                    <button
                        className="mj_RoomItemMenu_item"
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
    collapse?: { usageCollapsed: boolean; titleCollapsed: boolean };
}): React.ReactElement {
    const conversation = client.selectedConversation();
    const title = conversation ? conversationTitle(conversation) : "Conversation";
    const status = state.sessionStatus;
    const runState = conversation?.session_state;
    const limits = status?.limits?.filter((limit) => limit.label.trim());
    const meters = buildUsageMeters(status, limits);
    const shortModel = status?.model ? shortModelName(status.model) : undefined;
    const hasSubtitle = Boolean(status?.model || runState);
    return (
        <HeaderShell
            mode="parent"
            onBack={() => client.clearSelection()}
            backLabel="Back to conversations"
            title={title}
            subtitle={
                <>
                    {status?.model && <span className="mj_HeaderModel">{status.model}</span>}
                    {status?.workdir && <span className="mj_HeaderWorkdir">{status.workdir}</span>}
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
            rightControls={
                status?.context && (
                    <button
                        className="mj_CompactButton"
                        type="button"
                        aria-label="Compact conversation"
                        title="Compact the conversation — sends /compact"
                        onClick={() =>
                            void client
                                .sendMessage("/compact")
                                .catch((error) => console.warn("Compact command failed to send:", error))
                        }
                    >
                        <CompactIcon />
                        <span>Compact</span>
                    </button>
                )
            }
            persistentControls={
                // Keyed by conversation id so a selection change while the menu is open
                // remounts (and closes) it, instead of silently retargeting the actions.
                conversation && (
                    <HeaderOverflowMenu
                        key={conversation.id}
                        client={client}
                        conversation={conversation}
                        state={state}
                    />
                )
            }
            hideControlsWhenCompact
            limits={meters}
            collapse={collapse}
        />
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
    const meters = buildUsageMeters(status, limits);
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
            title={selected ? conversationTitle(selected) : "Subagent"}
            titleGlyph="↳"
            titleBadge={<span className="mj_HeaderSubagentBadge">subagent</span>}
            subtitle={
                <>
                    {parent && (
                        <span className="mj_HeaderParentRef">
                            of <span className="mj_HeaderParentName">{conversationTitle(parent)}</span>
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
    resolvedAction?: (itemId: string) => "send" | "cancel" | undefined;
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
            {resolution !== undefined && (
                <div className="mj_PromptResolved">
                    <span className="mj_PromptGlyph mj_PromptGlyph_ok" aria-hidden="true">
                        <PromptCheckGlyph />
                    </span>
                    <span className="mj_Answered">{resolution === "send" ? "Sent" : "Cancelled"}</span>
                </div>
            )}
        </div>
    );
}

function PromptCard({
    client,
    event,
    answered,
    permission = false,
    isReadOnly = false,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answered: boolean;
    permission?: boolean;
    isReadOnly?: boolean;
}): React.ReactElement {
    const [freeText, setFreeText] = useState("");
    const [locallyAnswered, setLocallyAnswered] = useState(false);
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
    const disabled = answered || locallyAnswered;
    const answer = (choice?: string, text?: string): void => {
        if (client.sendPromptReply(event.seq, choice, text)) setLocallyAnswered(true);
    };
    // §10.5 one primary per surface: exactly one filled affirmative. For permission it's
    // "Allow"; for a generic question the first option whose label reads affirmative
    // (send/yes/continue/confirm/ok/approve). Chosen by SEMANTICS, not position, so a
    // reordered payload never fills "Always allow" / "Deny" / "Cancel".
    const affirmativeIndex = options.findIndex((option) =>
        permission ? option.label.trim().toLocaleLowerCase() === "allow" : PROMPT_AFFIRMATIVE.test(option.label.trim()),
    );

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
                <span className="mj_PromptQuestion">{question}</span>
            </div>
            {!isReadOnly && !disabled && options.length > 0 && (
                <div className="mj_PromptOptions">
                    {options.map((option, index) => (
                        <button
                            key={`${option.label}:${option.value}`}
                            className={index === affirmativeIndex ? "mj_PromptOption_affirmative" : undefined}
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
            {disabled && (
                <div className="mj_PromptResolved">
                    <span className="mj_PromptGlyph mj_PromptGlyph_ok" aria-hidden="true">
                        <PromptCheckGlyph />
                    </span>
                    <span className="mj_Answered">Answered</span>
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

function PromptTerminalGlyph(): React.ReactElement {
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
            <path d="m5 7 5 5-5 5" />
            <path d="M13 17h6" />
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

function ToolOutput({ client, event }: { client: MatronJournalClient; event: JournalEvent }): React.ReactElement {
    const payload = event.payload;
    const command = asString(payload.command, asString(payload.tool_name, "Tool output"));
    const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : undefined;
    const failed = payload.denied === true || (exitCode !== undefined && exitCode !== 0);
    const expired = payload.expired === true;
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
        <details className={`mj_ToolCard ${failed ? "mj_ToolCard_failed" : ""}`}>
            <summary>
                <ChevronDownIcon className="mj_ToolCard_chevron" aria-hidden="true" />
                <code>$ {command}</code>
                <span className="mj_ToolCard_spacer" />
                <span className={`mj_ToolBadge ${failed ? "mj_ToolBadge_failed" : ""}`}>
                    {payload.denied === true
                        ? "denied"
                        : exitCode !== undefined
                          ? `exit ${exitCode}`
                          : failed
                            ? "failed"
                            : "done"}
                </span>
                <time className="mj_ToolTime" dateTime={new Date(event.ts).toISOString()}>
                    {formatTime(event.ts)}
                </time>
            </summary>
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

function AuthenticatedMedia({
    client,
    mediaId,
    image,
    filename,
    caption,
}: {
    client: MatronJournalClient;
    mediaId: string;
    image: boolean;
    filename?: string;
    caption?: string;
}): React.ReactElement {
    const [url, setUrl] = useState<string>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            setUrl(await client.mediaUrl(mediaId));
        } catch (loadError) {
            setError(errorMessage(loadError));
        } finally {
            setLoading(false);
        }
    }, [client, mediaId]);

    useEffect(() => {
        if (image) void load();
    }, [image, load]);

    if (error) return <div className="mj_Error">{error}</div>;
    if (image) {
        return url ? (
            <figure className="mj_Image">
                <img src={url} alt={caption || "Shared image"} />
                {caption && <figcaption>{caption}</figcaption>}
            </figure>
        ) : (
            <div className="mj_MediaLoading">{loading ? "Loading image…" : "Image"}</div>
        );
    }
    return url ? (
        <a className="mj_File" href={url} download={filename || "attachment"}>
            ↓ {filename || "Download attachment"}
        </a>
    ) : (
        <button className="mj_File" onClick={() => void load()} disabled={loading}>
            ↓ {loading ? "Preparing download…" : filename || "Download attachment"}
        </button>
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
// (pre-existing #455 code, unchanged here) already parses the full string before this
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

export function EventContent({
    client,
    event,
    answeredPrompts,
    isReadOnly = false,
    resolvedAction,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPrompts: Set<number>;
    isReadOnly?: boolean;
    resolvedAction?: (itemId: string) => "send" | "cancel" | undefined;
}): React.ReactElement {
    switch (event.type) {
        case "text":
            return (
                <div className="mj_Markdown">
                    <MarkdownBody text={asString(event.payload.body)} label={String(event.seq)} />
                </div>
            );
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
                    client={client}
                    event={event}
                    answered={answeredPrompts.has(event.seq)}
                    isReadOnly={isReadOnly}
                />
            );
        case "permission_request":
            return (
                <PromptCard
                    client={client}
                    event={event}
                    answered={answeredPrompts.has(event.seq)}
                    permission
                    isReadOnly={isReadOnly}
                />
            );
        case "prompt_reply":
            return (
                <div className="mj_MessageText">
                    {asString(event.payload.choice, asString(event.payload.text, "Answered"))}
                </div>
            );
        case "tool_output":
            return <ToolOutput client={client} event={event} />;
        case "diff":
            return <DiffCard data={parseDiffPayload(event.payload)} />;
        case "image": {
            const mediaId = asString(event.payload.blob_ref);
            return mediaId ? (
                <AuthenticatedMedia client={client} mediaId={mediaId} image caption={asString(event.payload.caption)} />
            ) : (
                <div className="mj_Muted">Image unavailable</div>
            );
        }
        case "file": {
            const mediaId = asString(event.payload.blob_ref);
            return (
                <div>
                    {mediaId ? (
                        <AuthenticatedMedia
                            client={client}
                            mediaId={mediaId}
                            image={false}
                            filename={asString(event.payload.filename, "attachment")}
                        />
                    ) : (
                        <span className="mj_Muted">File unavailable</span>
                    )}
                    {formatBytes(event.payload.size) && (
                        <span className="mj_FileSize">{formatBytes(event.payload.size)}</span>
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
    answeredPrompts,
    isReadOnly = false,
    resolvedAction,
    continuation = false,
    lastInSection = true,
    rowHandlers,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPrompts: Set<number>;
    isReadOnly?: boolean;
    resolvedAction: (itemId: string) => "send" | "cancel" | undefined;
    continuation?: boolean;
    lastInSection?: boolean;
    rowHandlers: RowContextMenu<JournalEvent>["rowHandlers"];
}): React.ReactElement {
    const own = event.sender.startsWith("user:");
    const liRef = useRef<HTMLLIElement>(null);
    const handlers = rowHandlers(event, () => liRef.current);
    return (
        <li
            ref={liRef}
            className={`mx_EventTile${continuation ? " mx_EventTile_continuation" : ""}${lastInSection ? " mx_EventTile_lastInSection" : ""}`}
            tabIndex={-1}
            aria-live="polite"
            aria-atomic="true"
            data-layout="bubble"
            data-self={own}
            data-event-id={event.seq}
            {...handlers}
            onClickCapture={handlers.onClickCapture}
        >
            {!own && !continuation && (
                <span className="mx_DisambiguatedProfile">
                    <MsgAvatar />
                    <span className="mx_DisambiguatedProfile_displayName">{displaySender(event.sender)}</span>
                    {/* tool_output owns its timestamp inline (after the exit badge); prompt /
                        permission cards own theirs in the card header (§10.2). Suppress the
                        profile-row time for all three so a first-in-section event never shows
                        two identical timestamps. */}
                    {event.type !== "tool_output" && event.type !== "prompt" && event.type !== "permission_request" && (
                        <a href={`#event-${event.seq}`} onClick={(clickEvent) => clickEvent.preventDefault()}>
                            <time className="mx_MessageTimestamp" dateTime={new Date(event.ts).toISOString()}>
                                {formatTime(event.ts)}
                            </time>
                        </a>
                    )}
                </span>
            )}
            <div className="mx_EventTile_line">
                {/* Own bubbles carry an inline timestamp (design: "…text <09:58>"). Agent
                    continuation blocks do NOT — the section shows one timestamp on the profile
                    row (§10.2 one-per-section), so continuation blocks fill to the shared right
                    edge with no reserved timestamp gutter (kills the first-block spill). */}
                {own && event.type !== "tool_output" && (
                    <a href={`#event-${event.seq}`} onClick={(clickEvent) => clickEvent.preventDefault()}>
                        <time className="mx_MessageTimestamp" dateTime={new Date(event.ts).toISOString()}>
                            {formatTime(event.ts)}
                        </time>
                    </a>
                )}
                <div className="mx_MTextBody mx_EventTile_content">
                    <div className="markdown-body">
                        <EventContent
                            client={client}
                            event={event}
                            answeredPrompts={answeredPrompts}
                            isReadOnly={isReadOnly}
                            resolvedAction={resolvedAction}
                        />
                    </div>
                </div>
            </div>
        </li>
    );
}

function MsgAvatar(): React.ReactElement {
    const mask = `url("${matronLogo}")`;

    return <span className="mj_MsgAvatar" style={{ WebkitMaskImage: mask, maskImage: mask }} aria-hidden />;
}

export function ToolStream({ stream }: { stream: ToolStreamState }): React.ReactElement {
    const nodes = useMemo(() => {
        const cleaned = stream.headTruncated ? stripLeadingSgrFragment(stream.content) : stream.content;
        const text = stream.headTruncated ? `… earlier output omitted …\n${cleaned}` : stream.content;
        return parseAnsi(text, INITIAL_SGR_STATE, "", 0).nodes;
    }, [stream.content, stream.headTruncated]);

    return (
        <li className="mx_EventTile mx_EventTile_lastInSection" tabIndex={-1} data-layout="bubble" data-self="false">
            <span className="mx_DisambiguatedProfile">
                <MsgAvatar />
                <span className="mx_DisambiguatedProfile_displayName">agent</span>
            </span>
            <div className="mx_EventTile_line">
                <div className="mx_MTextBody mx_EventTile_content">
                    <div className="markdown-body mj_LiveTool">
                        <div>
                            <span className="mj_LiveDot" /> Running{" "}
                            <code>{stream.command || stream.tool || "tool"}</code>
                        </div>
                        <pre>{nodes}</pre>
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
            className={`mx_EventTile mx_EventTile_lastInSection mj_AttachmentChip mj_AttachmentChip_${message.attachState ?? "sending"}`}
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
    const pendingScrollFrame = useRef<number | undefined>(undefined);
    const selectedConversationId = useRef(state.selectedConversationId);
    const [isFollowingTail, setFollow] = useState(true);
    const [sourceEvent, setSourceEvent] = useState<JournalEvent>();
    const menu = useRowContextMenu<JournalEvent>();
    const sourceOpenerRef = useRef<HTMLElement | null>(null);
    selectedConversationId.current = state.selectedConversationId;

    useEffect(() => {
        menu.close();
        setSourceEvent(undefined);
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
    const { queuedReleasePromptSeqs, legacyQueuePromptSeqs } = useMemo(() => {
        const queuedReleasePromptSeqs = new Set<number>();
        const legacyQueuePromptSeqs = new Set<number>();
        for (const event of state.events) {
            if (event.type !== "prompt") continue;
            if (asString(event.payload.kind) === "queued_release") queuedReleasePromptSeqs.add(event.seq);
            else if (isLegacyQueuePrompt(event)) legacyQueuePromptSeqs.add(event.seq);
        }
        return { queuedReleasePromptSeqs, legacyQueuePromptSeqs };
    }, [state.events]);
    const visibleEvents = useMemo(
        () =>
            state.events.filter(
                (event) =>
                    !["read_marker", "edit", "session_status", "convo_meta"].includes(event.type) &&
                    !isQueuedReleaseReply(event, queuedReleasePromptSeqs, legacyQueuePromptSeqs),
            ),
        [state.events, queuedReleasePromptSeqs, legacyQueuePromptSeqs],
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
    const answeredPrompts = useMemo(
        () =>
            new Set(
                state.events
                    .filter((event) => event.type === "prompt_reply")
                    .map((event) => asNumber(event.payload.target_seq))
                    .filter(Boolean),
            ),
        [state.events],
    );
    const releasedActions = useMemo(() => {
        const actions = new Map<string, "send" | "cancel">();
        for (const event of state.events) {
            if (
                event.type !== "prompt_reply" ||
                asString(event.payload.kind) !== "queued_release" ||
                !Array.isArray(event.payload.released)
            )
                continue;
            const action = asString(event.payload.action);
            if (action !== "send" && action !== "cancel") continue;
            for (const releasedId of event.payload.released) {
                const itemId = asString(releasedId);
                if (itemId) actions.set(itemId, action);
            }
        }
        return actions;
    }, [state.events]);
    const resolvedAction = useCallback(
        (itemId: string): "send" | "cancel" | undefined => releasedActions.get(itemId),
        [releasedActions],
    );
    const scrollToBottom = useCallback((): void => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, []);
    const cancelPendingScrollFrame = useCallback((): void => {
        if (pendingScrollFrame.current === undefined) return;
        cancelAnimationFrame(pendingScrollFrame.current);
        pendingScrollFrame.current = undefined;
    }, []);
    const onScroll = (): void => {
        const node = scrollRef.current;
        if (!node) return;
        cancelPendingScrollFrame();
        const queuedConversationId = state.selectedConversationId;
        pendingScrollFrame.current = requestAnimationFrame(() => {
            pendingScrollFrame.current = undefined;
            if (selectedConversationId.current !== queuedConversationId) return;
            setFollow(isNearBottom(node.scrollTop, node.scrollHeight, node.clientHeight));
        });
    };

    useEffect(() => {
        setFollow(true);
        return cancelPendingScrollFrame;
    }, [state.selectedConversationId, cancelPendingScrollFrame]);

    useEffect(() => {
        cancelPendingScrollFrame();
        historyScrollAnchor.current = undefined;
        historyScrollRestored.current = false;
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
    ]);

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

    return (
        <main className="mx_RoomView_timeline" data-testid="timeline">
            <div className="mx_RoomView_messagePanel mx_AutoHideScrollbar" ref={scrollRef} onScroll={onScroll}>
                <div className="mx_RoomView_messageListWrapper">
                    <ol className="mx_RoomView_MessageList" aria-live="polite">
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
                        {timeline.map((item, index) => {
                            const previous = timeline[index - 1];
                            // A day divider precedes the first row of each new calendar day (§ upload-first
                            // ref): a centred dated label flanked by hairline rules.
                            const divider =
                                !previous || !sameCalendarDay(item.timestamp, previous.timestamp) ? (
                                    <li className="mj_DateDivider" role="separator">
                                        <span className="mj_DateDivider_rule" aria-hidden="true" />
                                        <span className="mj_DateDivider_label">{formatDayDivider(item.timestamp)}</span>
                                        <span className="mj_DateDivider_rule" aria-hidden="true" />
                                    </li>
                                ) : null;
                            if (item.kind === "event") {
                                const next = timeline[index + 1];
                                return (
                                    <React.Fragment key={`e-${item.event.seq}`}>
                                        {divider}
                                        <EventRow
                                            client={client}
                                            event={item.event}
                                            answeredPrompts={answeredPrompts}
                                            isReadOnly={isReadOnly}
                                            resolvedAction={resolvedAction}
                                            continuation={
                                                previous?.kind === "event" &&
                                                previous.event.sender === item.event.sender &&
                                                !divider
                                            }
                                            lastInSection={
                                                next?.kind !== "event" || next.event.sender !== item.event.sender
                                            }
                                            rowHandlers={menu.rowHandlers}
                                        />
                                    </React.Fragment>
                                );
                            }
                            const message = item.message;
                            return (
                                <React.Fragment key={`m-${message.localId}`}>
                                    {divider}
                                    {message.kind === "image" || message.kind === "file" ? (
                                        <PendingAttachment client={client} message={message} isReadOnly={isReadOnly} />
                                    ) : (
                                        <li
                                            className="mx_EventTile mx_EventTile_sending mx_EventTile_lastInSection"
                                            data-layout="bubble"
                                            data-self="true"
                                        >
                                            <div className="mx_EventTile_line">
                                                <div className="mx_MTextBody mx_EventTile_content">
                                                    <div className="mj_Markdown">
                                                        <MarkdownBody text={message.body} label={message.localId} />
                                                    </div>
                                                </div>
                                            </div>
                                            <span className="mj_SendingLabel">Sending…</span>
                                        </li>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        {Object.values(state.textStreams).map((text, index) => (
                            <li
                                className="mx_EventTile mx_EventTile_lastInSection"
                                key={`text-stream-${index}`}
                                data-layout="bubble"
                                data-self="false"
                            >
                                <span className="mx_DisambiguatedProfile">
                                    <MsgAvatar />
                                    <span className="mx_DisambiguatedProfile_displayName">agent</span>
                                </span>
                                <div className="mx_EventTile_line">
                                    <div className="mx_MTextBody mx_EventTile_content">
                                        <div className="mj_Markdown mj_Markdown_streaming">
                                            <MarkdownBody text={text} streaming label={`stream-${index}`} />
                                            <span className="mj_Cursor" />
                                        </div>
                                    </div>
                                </div>
                            </li>
                        ))}
                        {Object.values(state.toolStreams).map((stream) => (
                            <ToolStream key={stream.messageRef} stream={stream} />
                        ))}
                        {state.activity && state.activity.state !== "idle" && (
                            <li className="mx_WhoIsTypingTile mj_Activity">
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
            </div>
            {!isFollowingTail && (
                <button
                    className="mj_JumpToBottom"
                    aria-label="Jump to bottom"
                    onClick={() => {
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
                                className="mj_RoomItemMenu_item"
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
                                className="mj_RoomItemMenu_item"
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
                        </>
                    )}
                    <button
                        className="mj_RoomItemMenu_item"
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
        </main>
    );
}

const SLASH_LISTBOX_ID = "mx_SlashPalette_listbox";
const slashRowId = (index: number): string => `${SLASH_LISTBOX_ID}_opt_${index}`;

function SlashCommandPalette({
    commands,
    folders,
    highlighted,
    onHighlight,
    onSelectCommand,
    onSelectFolder,
}: {
    commands: BotCommand[];
    folders: string[];
    highlighted: number | null;
    onHighlight: (index: number | null) => void;
    onSelectCommand: (command: BotCommand) => void;
    onSelectFolder: (path: string) => void;
}): React.ReactElement {
    const highlightedRow = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (highlighted !== null) highlightedRow.current?.scrollIntoView({ block: "nearest" });
    }, [highlighted]);

    return (
        <div className="mx_SlashPalette" id={SLASH_LISTBOX_ID} role="listbox">
            {folders.length > 0
                ? folders.map((folder, index) => (
                      <div
                          className={`mx_SlashPalette_row${
                              highlighted === index ? " mx_SlashPalette_row_highlighted" : ""
                          }`}
                          id={slashRowId(index)}
                          key={`${folder}-${index}`}
                          ref={highlighted === index ? highlightedRow : undefined}
                          role="option"
                          aria-selected={highlighted === index}
                          onMouseEnter={() => onHighlight(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => onSelectFolder(folder)}
                      >
                          <span className="mx_SlashPalette_trigger">{folder}</span>
                      </div>
                  ))
                : commands.map((command, index) => (
                      <div
                          className={`mx_SlashPalette_row${
                              highlighted === index ? " mx_SlashPalette_row_highlighted" : ""
                          }`}
                          id={slashRowId(index)}
                          key={command.trigger}
                          ref={highlighted === index ? highlightedRow : undefined}
                          role="option"
                          aria-selected={highlighted === index}
                          onMouseEnter={() => onHighlight(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => onSelectCommand(command)}
                      >
                          <span className="mx_SlashPalette_trigger">{command.trigger}</span>
                          {command.argHint && <span className="mx_SlashPalette_argHint">{command.argHint}</span>}
                          <span className="mx_SlashPalette_summary">{command.summary}</span>
                      </div>
                  ))}
        </div>
    );
}

function Composer({
    client,
    state,
    drafts,
    draftReloadTick,
    reloadDraft,
    sendingConvos,
    draftRevisions,
}: {
    client: MatronJournalClient;
    state: ClientState;
    drafts: DraftStore;
    draftReloadTick: number;
    reloadDraft: (conversationId: string) => void;
    sendingConvos: React.RefObject<Set<string>>;
    draftRevisions: React.RefObject<Map<string, number>>;
}): React.ReactElement {
    const [body, setBody] = useState("");
    const [highlighted, setHighlighted] = useState<number | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [nonDurable, setNonDurable] = useState(false);
    const store = useMemo(() => makeRecentFoldersStore(state.session), [state.session]);
    const [dismissedSeq, setDismissedSeq] = useState(0);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const convoId = state.selectedConversationId;
    const convoIdRef = useRef(convoId);
    convoIdRef.current = convoId;
    const prevConvoIdRef = useRef(convoId);
    const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const draftTimerConvoRef = useRef<string | undefined>(undefined);
    const [voiceState, reactSetVoiceState] = useState<"idle" | "requesting" | "recording" | "error">("idle");
    const [elapsedMs, setElapsedMs] = useState(0);
    const [waveformActive, setWaveformActive] = useState(false);
    const genRef = useRef(0);
    const mediaRecorder = useRef<MediaRecorder | null>(null);
    const mediaStream = useRef<MediaStream | null>(null);
    const audioContext = useRef<AudioContext | null>(null);
    const analyser = useRef<AnalyserNode | null>(null);
    const rafId = useRef<number | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recMimeRef = useRef<string | undefined>(undefined);
    const recordingStartMs = useRef(0);
    const deadlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const acquireTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const errorMsg = useRef<string | null>(null);
    const mountedRef = useRef(false);
    const voiceStateRef = useRef<"idle" | "requesting" | "recording" | "error">("idle");
    const dispositionRef = useRef<"send" | "discard">("discard");
    const sendInFlightRef = useRef(false);
    const stopInFlightRef = useRef(false);
    const finalizedRef = useRef(false);
    const recordingIdRef = useRef(0);
    const capConvoRef = useRef<string | undefined>(undefined);
    const recordingSessionGenRef = useRef(0);
    const visibilityHandlerRef = useRef<(() => void) | null>(null);
    const voiceConvoRef = useRef(convoId);
    const composerRef = useRef<HTMLDivElement>(null);
    const micButtonRef = useRef<HTMLButtonElement>(null);
    const stopButtonRef = useRef<HTMLButtonElement>(null);
    const restoreVoiceFocusRef = useRef(false);
    const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
    const folders = folderSuggestions(body, store);
    const commands = filterCommands(CLAUDE_BRIDGE_COMMANDS, body);
    const open = body !== dismissed && (folders.length > 0 || (isCommandMode(body) && commands.length > 0));
    const voiceSupported = Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder !== "undefined";
    const elapsedMinutes = Math.floor(elapsedMs / 60_000);
    const elapsedSeconds = Math.floor((elapsedMs % 60_000) / 1000);
    const elapsedLabel = `${elapsedMinutes}:${String(elapsedSeconds).padStart(2, "0")}`;

    const setVoiceState = useCallback((next: "idle" | "requesting" | "recording" | "error"): void => {
        voiceStateRef.current = next;
        reactSetVoiceState(next);
    }, []);

    const releaseMedia = useCallback((): void => {
        if (deadlineTimer.current !== null) {
            clearTimeout(deadlineTimer.current);
            deadlineTimer.current = null;
        }
        if (tickTimer.current !== null) {
            clearInterval(tickTimer.current);
            tickTimer.current = null;
        }
        if (rafId.current !== null) {
            cancelAnimationFrame(rafId.current);
            rafId.current = null;
        }
        mediaStream.current?.getTracks().forEach((track) => track.stop());
        mediaStream.current = null;
        const context = audioContext.current;
        audioContext.current = null;
        analyser.current = null;
        if (context && context.state !== "closed") void context.close().catch(() => undefined);
        if (visibilityHandlerRef.current) {
            document.removeEventListener("visibilitychange", visibilityHandlerRef.current);
            visibilityHandlerRef.current = null;
        }
    }, []);

    const releaseResources = useCallback((): void => {
        releaseMedia();
        if (watchdogTimer.current !== null) {
            clearTimeout(watchdogTimer.current);
            watchdogTimer.current = null;
        }
        mediaRecorder.current = null;
    }, [releaseMedia]);

    const finalizeVoice = useCallback(
        (rid: number, localChunks: Blob[]): void => {
            if (rid !== recordingIdRef.current) return;
            if (finalizedRef.current) return;
            finalizedRef.current = true;

            const mime = recMimeRef.current || "audio/webm";
            const blob = localChunks.length ? new Blob(localChunks, { type: mime }) : null;
            const wantSend = dispositionRef.current === "send";
            const capturedConvo = capConvoRef.current;
            const capturedSessionGen = recordingSessionGenRef.current;
            releaseResources();

            if (wantSend && !blob) {
                if (mountedRef.current) {
                    errorMsg.current = "Recording failed to save.";
                    setVoiceState("error");
                }
                console.warn("voice: committed recording contained no audio", {
                    rid,
                    disposition: dispositionRef.current,
                    chunks: localChunks.length,
                    elapsedMs: Date.now() - recordingStartMs.current,
                });
                sendInFlightRef.current = false;
                stopInFlightRef.current = false;
                return;
            }

            if (mountedRef.current && voiceStateRef.current !== "error") {
                restoreVoiceFocusRef.current = Boolean(composerRef.current?.contains(document.activeElement));
                setVoiceState("idle");
                setElapsedMs(0);
            }

            if (wantSend && blob && capturedConvo && client.sessionGeneration !== capturedSessionGen) {
                console.warn("voice: session changed before finalize — recording not sent", { rid });
            }

            if (wantSend && blob && capturedConvo && client.sessionGeneration === capturedSessionGen) {
                const onFail = (): void => {
                    if (mountedRef.current && voiceStateRef.current === "idle") {
                        errorMsg.current = "Couldn't save the recording — try again.";
                        setVoiceState("error");
                    }
                };
                void client
                    .sendVoiceNote(blob, capturedConvo, capturedSessionGen)
                    .then((outcome) => {
                        if (outcome !== "sent" && outcome !== "persisted-terminal") onFail();
                    })
                    .catch(onFail);
            }
            sendInFlightRef.current = false;
            stopInFlightRef.current = false;
        },
        [client, releaseResources, setVoiceState],
    );

    const stopRecorder = useCallback(
        (disposition: "send" | "discard"): void => {
            const recorder = mediaRecorder.current;
            if (!recorder || recorder.state === "inactive") return;
            if (disposition === "send") {
                dispositionRef.current = "send";
                sendInFlightRef.current = true;
            } else if (!sendInFlightRef.current) {
                dispositionRef.current = "discard";
            }
            stopInFlightRef.current = true;
            const rid = recordingIdRef.current;
            const localChunks = chunksRef.current;
            watchdogTimer.current = setTimeout(() => {
                if (rid !== recordingIdRef.current || finalizedRef.current) return;
                console.warn("voice: onstop absent — watchdog finalizing", {
                    rid,
                    chunks: localChunks.length,
                    elapsedMs: Date.now() - recordingStartMs.current,
                });
                finalizeVoice(rid, localChunks);
            }, 3000);
            recorder.stop();
        },
        [finalizeVoice],
    );

    const startWaveform = useCallback((): void => {
        const values = new Uint8Array(analyser.current?.frequencyBinCount ?? 0);
        const reducedMotion =
            typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const draw = (): void => {
            const canvas = waveformCanvasRef.current;
            const currentAnalyser = analyser.current;
            if (canvas && currentAnalyser) {
                const context = canvas.getContext("2d");
                if (context) {
                    const width = Math.max(1, Math.floor(canvas.clientWidth * window.devicePixelRatio));
                    const height = Math.max(1, Math.floor(canvas.clientHeight * window.devicePixelRatio));
                    if (canvas.width !== width) canvas.width = width;
                    if (canvas.height !== height) canvas.height = height;
                    if (!reducedMotion) currentAnalyser.getByteTimeDomainData(values);
                    context.clearRect(0, 0, width, height);
                    const computed = getComputedStyle(canvas);
                    context.strokeStyle =
                        computed.getPropertyValue("--cpd-color-icon-accent-primary").trim() || computed.color;
                    context.lineWidth = Math.max(1, window.devicePixelRatio);
                    context.beginPath();
                    for (let index = 0; index < values.length; index += 1) {
                        const x = (index / Math.max(1, values.length - 1)) * width;
                        const y = reducedMotion ? height / 2 : (values[index] / 255) * height;
                        if (index === 0) context.moveTo(x, y);
                        else context.lineTo(x, y);
                    }
                    context.stroke();
                }
            }
            rafId.current = requestAnimationFrame(draw);
        };
        draw();
    }, []);

    const startRecording = useCallback(
        (stream: MediaStream): void => {
            const rid = ++recordingIdRef.current;
            const localChunks: Blob[] = [];
            chunksRef.current = localChunks;
            recMimeRef.current = undefined;
            mediaStream.current = stream;
            recordingSessionGenRef.current = client.sessionGeneration;
            setWaveformActive(false);
            try {
                const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((candidate) =>
                    window.MediaRecorder.isTypeSupported(candidate),
                );
                const recorder = mimeType
                    ? new window.MediaRecorder(stream, { mimeType })
                    : new window.MediaRecorder(stream);
                mediaRecorder.current = recorder;
                recorder.onstart = () => {
                    if (rid !== recordingIdRef.current || localChunks !== chunksRef.current) return;
                    recMimeRef.current ||= recorder.mimeType || undefined;
                };
                recorder.ondataavailable = (event) => {
                    if (rid !== recordingIdRef.current || localChunks !== chunksRef.current) return;
                    recMimeRef.current ||= event.data.type || undefined;
                    if (event.data.size) localChunks.push(event.data);
                };
                recorder.onstop = () => {
                    if (rid !== recordingIdRef.current || localChunks !== chunksRef.current) return;
                    finalizeVoice(rid, localChunks);
                };
                recorder.onerror = () => {
                    if (rid !== recordingIdRef.current || localChunks !== chunksRef.current) return;
                    releaseMedia();
                    errorMsg.current = "Recording stopped unexpectedly.";
                    setVoiceState("error");
                    stopRecorder("discard");
                };

                try {
                    const context = new window.AudioContext();
                    audioContext.current = context;
                    const currentAnalyser = context.createAnalyser();
                    currentAnalyser.fftSize = 256;
                    analyser.current = currentAnalyser;
                    context.createMediaStreamSource(stream).connect(currentAnalyser);
                    startWaveform();
                    setWaveformActive(true);
                } catch {
                    if (rafId.current !== null) {
                        cancelAnimationFrame(rafId.current);
                        rafId.current = null;
                    }
                    const context = audioContext.current;
                    audioContext.current = null;
                    analyser.current = null;
                    if (context && context.state !== "closed") void context.close().catch(() => undefined);
                }

                dispositionRef.current = "discard";
                sendInFlightRef.current = false;
                stopInFlightRef.current = false;
                finalizedRef.current = false;
                recordingStartMs.current = Date.now();
                setElapsedMs(0);
                tickTimer.current = setInterval(() => {
                    setElapsedMs(Date.now() - recordingStartMs.current);
                }, 500);
                const capMs = 5 * 60 * 1000;
                deadlineTimer.current = setTimeout(() => {
                    if (Date.now() - recordingStartMs.current >= capMs) stopRecorder("send");
                }, capMs);
                const reconcileDurationCap = (): void => {
                    if (document.visibilityState === "visible" && Date.now() - recordingStartMs.current >= capMs) {
                        stopRecorder("send");
                    }
                };
                visibilityHandlerRef.current = reconcileDurationCap;
                document.addEventListener("visibilitychange", reconcileDurationCap);

                recorder.start(1000);
                setVoiceState("recording");
            } catch {
                stream.getTracks().forEach((track) => track.stop());
                releaseResources();
                errorMsg.current = "Couldn't start recording.";
                setVoiceState("error");
            }
        },
        [client, finalizeVoice, releaseMedia, releaseResources, setVoiceState, startWaveform, stopRecorder],
    );

    const acquireVoice = useCallback((): void => {
        if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === "undefined") return;
        const gen = ++genRef.current;
        setVoiceState("requesting");
        capConvoRef.current = convoIdRef.current;
        errorMsg.current = null;
        const localTimer = setTimeout(() => {
            if (gen === genRef.current && voiceStateRef.current === "requesting") {
                if (acquireTimer.current === localTimer) acquireTimer.current = null;
                ++genRef.current;
                errorMsg.current = "Microphone request timed out — try again.";
                setVoiceState("error");
            }
        }, 20_000);
        acquireTimer.current = localTimer;
        void navigator.mediaDevices.getUserMedia({ audio: true }).then(
            (stream) => {
                clearTimeout(localTimer);
                if (acquireTimer.current === localTimer) acquireTimer.current = null;
                if (gen !== genRef.current || !mountedRef.current) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }
                startRecording(stream);
            },
            (error: unknown) => {
                clearTimeout(localTimer);
                if (acquireTimer.current === localTimer) acquireTimer.current = null;
                if (gen !== genRef.current) return;
                const name =
                    typeof error === "object" && error !== null && "name" in error
                        ? String((error as { name: unknown }).name)
                        : "";
                errorMsg.current =
                    name === "NotAllowedError" || name === "SecurityError"
                        ? "Microphone access denied."
                        : name === "NotFoundError"
                          ? "No microphone found."
                          : "Couldn't access the microphone.";
                setVoiceState("error");
            },
        );
    }, [setVoiceState, startRecording]);

    const commitVoiceStop = useCallback(
        (disposition: "send" | "discard"): void => {
            stopRecorder(disposition);
            composerRef.current?.querySelectorAll<HTMLButtonElement>(".mj_VoiceRecording_action").forEach((button) => {
                button.disabled = stopInFlightRef.current;
            });
        },
        [stopRecorder],
    );

    const teardownVoice = useCallback((): void => {
        ++genRef.current;
        if (acquireTimer.current !== null) {
            clearTimeout(acquireTimer.current);
            acquireTimer.current = null;
        }
        if (voiceStateRef.current === "requesting") {
            if (mountedRef.current) setVoiceState("idle");
            return;
        }
        if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") stopRecorder("discard");
        releaseMedia();
    }, [releaseMedia, setVoiceState, stopRecorder]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            teardownVoice();
        };
    }, [teardownVoice]);

    useLayoutEffect(() => {
        if (voiceConvoRef.current !== convoId) {
            teardownVoice();
            voiceConvoRef.current = convoId;
        }
    }, [convoId, teardownVoice]);

    useLayoutEffect(() => {
        if (voiceState === "recording") {
            stopButtonRef.current?.focus();
        } else if (voiceState === "idle") {
            const shouldRestoreFocus = restoreVoiceFocusRef.current;
            restoreVoiceFocusRef.current = false;
            if (shouldRestoreFocus && capConvoRef.current === convoIdRef.current) {
                micButtonRef.current?.focus();
            }
        }
    }, [voiceState]);

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
        [draftRevisions, drafts, syncDurability],
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
        // Sync the badge FROM the store for the newly-selected convo — never a blind reset, so a
        // still-non-durable convo keeps its warning across switch-away/back (and a clear-failure flag surfaces).
        setNonDurable(convoId ? drafts.durability(convoId) === "non-durable" : false);
        if (textarea.current) textarea.current.style.height = "auto";
        prevConvoIdRef.current = convoId;
    }, [convoId, draftReloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

    const selectCommand = (command: BotCommand): void => {
        setBodyDraft(applyCommand(command.trigger));
        setHighlighted(null);
        textarea.current?.focus();
    };
    const selectFolder = (path: string): void => {
        const nextBody = applyFolder(body, path);
        setBodyDraft(nextBody);
        setDismissed(nextBody);
        setHighlighted(null);
        textarea.current?.focus();
    };
    const send = async (): Promise<void> => {
        const cid = convoIdRef.current;
        const submitted = body;
        if (!cid || !submitted.trim() || sendingConvos.current.has(cid)) return;
        const submittedRevision = draftRevisions.current.get(cid) ?? 0;
        sendingConvos.current.add(cid);
        try {
            if (await client.sendMessage(submitted, cid)) {
                const folder = recentFolderArgument(submitted);
                if (folder) store.record(folder);
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
                    setDismissed(null);
                    if (textarea.current) textarea.current.style.height = "auto";
                }
            }
        } catch (error) {
            console.warn("matron: message not queued (outbox write failed)", error);
        } finally {
            sendingConvos.current.delete(cid);
        }
    };
    // v4 composer hint carries a live "ctx N%" readout on the right when context usage is known.
    const ctxHintRaw = normalizePercent(state.sessionStatus?.context?.pct ?? NaN);
    const ctxHintPct = ctxHintRaw === null ? null : Math.round(ctxHintRaw);
    return (
        <div className="mx_MessageComposer" role="region" aria-label="Message composer" ref={composerRef}>
            <div className="mx_MessageComposer_wrapper">
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
                {voiceState === "error" && errorMsg.current && (
                    <div className="mj_ConnectionError mj_VoiceError">
                        <span role="status">{errorMsg.current}</span>
                        <button
                            className="mj_ConnectionError_dismiss"
                            type="button"
                            aria-label="Dismiss recording error"
                            title="Dismiss recording error"
                            onClick={() => {
                                errorMsg.current = null;
                                setVoiceState("idle");
                            }}
                        >
                            <CloseIcon />
                        </button>
                    </div>
                )}
                {nonDurable && (
                    <div className="mj_DraftNonDurable" role="status">
                        Draft won't be saved — storage full
                    </div>
                )}
                {open && (
                    <SlashCommandPalette
                        commands={commands}
                        folders={folders}
                        highlighted={highlighted}
                        onHighlight={setHighlighted}
                        onSelectCommand={selectCommand}
                        onSelectFolder={selectFolder}
                    />
                )}
                {voiceState === "recording" ? (
                    <div className="mj_VoiceRecording">
                        <span className="mj_VoiceRecording_dot" aria-hidden="true" />
                        {waveformActive ? (
                            <canvas className="mj_VoiceRecording_waveform" ref={waveformCanvasRef} aria-hidden="true" />
                        ) : (
                            <span className="mj_VoiceRecording_waveformFallback" aria-hidden="true" />
                        )}
                        <span className="mj_VoiceRecording_time" aria-hidden="true">
                            {elapsedLabel}
                        </span>
                        <span className="mj_ScreenReaderOnly" aria-live="polite">
                            Recording, {elapsedLabel}
                        </span>
                        <button
                            className="mj_VoiceRecording_action"
                            type="button"
                            aria-label="Discard recording"
                            title="Discard recording"
                            disabled={stopInFlightRef.current}
                            onClick={() => commitVoiceStop("discard")}
                        >
                            <TrashIcon />
                        </button>
                        <button
                            ref={stopButtonRef}
                            className="mj_VoiceRecording_action mj_VoiceRecording_stop"
                            type="button"
                            aria-label="Stop and send voice message"
                            title="Stop and send voice message"
                            disabled={stopInFlightRef.current}
                            onClick={() => commitVoiceStop("send")}
                        >
                            <StopIcon />
                        </button>
                    </div>
                ) : (
                    <div className="mx_MessageComposer_row">
                        {/* v5 composer.shell: attach sits INSIDE the field on the left,
                            before the textarea; mic + send stay on the right. */}
                        <button
                            className="mx_MessageComposer_button"
                            title="Attach a file"
                            aria-label="Attach a file"
                            onClick={() => fileInput.current?.click()}
                        >
                            <AttachmentIcon />
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
                        <div className="mx_SendMessageComposer" onClick={() => textarea.current?.focus()}>
                            <div className="mx_BasicMessageComposer">
                                <textarea
                                    className="mx_BasicMessageComposer_input"
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
                                        event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                                        if (open) {
                                            const count = folders.length || commands.length;
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
                                                const index = highlighted ?? 0;
                                                if (folders.length > 0) selectFolder(folders[index]);
                                                else selectCommand(commands[index]);
                                                return;
                                            }
                                            if (event.key === "Escape") {
                                                event.preventDefault();
                                                setDismissed(body);
                                                setHighlighted(null);
                                                return;
                                            }
                                            if (event.key === "Enter" && !event.shiftKey && highlighted !== null) {
                                                event.preventDefault();
                                                if (folders.length > 0) selectFolder(folders[highlighted]);
                                                else selectCommand(commands[highlighted]);
                                                return;
                                            }
                                        }
                                        if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            void send();
                                        }
                                    }}
                                    onPaste={(event) => {
                                        if (state.stagedUploads) return;
                                        const files = [...event.clipboardData.files];
                                        if (files.length > 0) {
                                            event.preventDefault();
                                            client.stageFiles(files);
                                        }
                                    }}
                                    placeholder={
                                        state.connection === "online"
                                            ? "Send a message…"
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
                        <div className="mx_MessageComposer_actions">
                            <button
                                ref={micButtonRef}
                                className="mx_MessageComposer_button"
                                title={
                                    voiceSupported
                                        ? voiceState === "requesting"
                                            ? "Requesting microphone access…"
                                            : "Record voice message"
                                        : "Voice recording isn't supported in this browser."
                                }
                                aria-label={
                                    voiceState === "requesting"
                                        ? "Requesting microphone access"
                                        : "Record voice message"
                                }
                                aria-busy={voiceState === "requesting"}
                                aria-disabled={!voiceSupported || voiceState === "requesting"}
                                disabled={!voiceSupported || voiceState === "requesting"}
                                onClick={acquireVoice}
                            >
                                {voiceState === "requesting" ? (
                                    <span className="mj_Spinner" aria-hidden="true" />
                                ) : (
                                    <MicOnIcon />
                                )}
                            </button>
                            <button
                                className="mx_MessageComposer_sendMessage"
                                type="button"
                                onClick={() => void send()}
                                disabled={!body.trim()}
                                aria-label="Send message"
                            >
                                <SendIcon />
                            </button>
                        </div>
                    </div>
                )}
                <div id="mj-composer-hint" className="mj_ComposerHint">
                    <span className="mj_ComposerHint_keys">/ commands · shift+enter for newline</span>
                    {ctxHintPct !== null && (
                        <span className="mj_ComposerHint_live" aria-hidden="true">
                            ctx {ctxHintPct}%
                        </span>
                    )}
                </div>
            </div>
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
                    <button type="button" className="mj_EventSource_secondary" onClick={onClose}>
                        Close
                    </button>
                    <button
                        type="button"
                        className="mj_EventSource_copy"
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

function UploadConfirmDialog({
    client,
    staged,
}: {
    client: MatronJournalClient;
    staged: StagedUploads;
}): React.ReactElement {
    useEffect(() => {
        const onPaste = (event: ClipboardEvent): void => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length > 0) {
                event.preventDefault();
                client.stageFiles(files);
            }
        };
        const preventDropNavigation = (event: DragEvent): void => event.preventDefault();
        document.addEventListener("paste", onPaste);
        document.addEventListener("dragover", preventDropNavigation);
        document.addEventListener("drop", preventDropNavigation);
        return () => {
            document.removeEventListener("paste", onPaste);
            document.removeEventListener("dragover", preventDropNavigation);
            document.removeEventListener("drop", preventDropNavigation);
        };
    }, [client]);

    if (staged.error) {
        return (
            <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-label="Upload error">
                <div className="mj_UploadConfirm">
                    <p className="mj_UploadConfirm_error">
                        This conversation was archived in another tab. Attachment(s) were not sent.
                    </p>
                    <div className="mj_UploadConfirm_actions">
                        <button aria-label="Close" onClick={() => client.cancelStagedFiles()}>
                            Close
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const head = staged.items[0];
    if (!head) return <></>;
    return (
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-label={head.file.name}>
            <UploadConfirmPage key={head.id} client={client} staged={staged} head={head} />
        </div>
    );
}

function UploadConfirmPage({
    client,
    staged,
    head,
}: {
    client: MatronJournalClient;
    staged: StagedUploads;
    head: StagedUploadItem;
}): React.ReactElement {
    const isImage = head.file.type.startsWith("image/");
    const preflight =
        head.file.size === 0
            ? "That file is empty."
            : head.file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES
              ? "This file is too large for this browser to upload safely."
              : undefined;
    const canSend = !preflight && !staged.confirming;
    const [caption, setCaption] = useState("");
    const textarea = useRef<HTMLTextAreaElement>(null);
    const [previewUrl, setPreviewUrl] = useState<string>();
    const position = staged.total - staged.items.length + 1;

    useEffect(() => {
        textarea.current?.focus();
        if (!isImage || preflight) return undefined;
        const url = URL.createObjectURL(head.file);
        setPreviewUrl(url);
        return () => {
            URL.revokeObjectURL(url);
        };
        // Mounted once per page (keyed by head.id at the call site).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const send = (): void => {
        if (!canSend) return;
        void client.confirmStagedFile(head.id, caption);
    };

    return (
        <div className="mj_UploadConfirm mj_UploadConfirm_queue">
            <header className="mj_UploadConfirm_header">
                {/* §10.1/§10.2: the title is ALWAYS "Send file" (never the filename — the
                    filename lives in the file-info row below). "n of N" is a chip. */}
                <h2 className="mj_UploadConfirm_title">Send file</h2>
                {staged.total > 1 && (
                    <span className="mj_UploadConfirm_count">
                        {position} of {staged.total}
                    </span>
                )}
            </header>
            <div className="mj_UploadConfirm_body">
                {isImage && previewUrl ? (
                    <img className="mj_UploadConfirm_preview" src={previewUrl} alt={head.file.name} />
                ) : (
                    <div className="mj_UploadConfirm_previewPlaceholder" aria-hidden="true">
                        <AttachmentIcon />
                    </div>
                )}
                <div className="mj_UploadConfirm_fileMeta">
                    <span className="mj_UploadConfirm_fileName">{head.file.name}</span>
                    <span className="mj_FileSize">{formatBytes(head.file.size)}</span>
                </div>
                {staged.total > 1 && (
                    <div className="mj_UploadConfirm_strip" role="list" aria-label="Queued files">
                        {staged.items.map((item) => {
                            const active = item.id === head.id;
                            return (
                                <span
                                    key={item.id}
                                    role="listitem"
                                    className={active ? "mj_UploadThumb mj_UploadThumb_active" : "mj_UploadThumb"}
                                    title={item.file.name}
                                >
                                    {active && isImage && previewUrl ? (
                                        <img src={previewUrl} alt="" />
                                    ) : (
                                        <AttachmentIcon aria-hidden />
                                    )}
                                </span>
                            );
                        })}
                        {staged.items.length > 1 && (
                            <span className="mj_UploadConfirm_more">{staged.items.length - 1} more file queued</span>
                        )}
                    </div>
                )}
                {preflight && <p className="mj_UploadConfirm_error">{preflight}</p>}
                {staged.persistError && (
                    <p className="mj_UploadConfirm_error">Couldn&apos;t save this attachment — try Send again.</p>
                )}
                <textarea
                    ref={textarea}
                    className="mj_UploadConfirm_caption"
                    placeholder="Add a caption…"
                    maxLength={4096}
                    value={caption}
                    onChange={(event) => setCaption(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            send();
                        } else if (event.key === "Escape" && !staged.confirming) {
                            event.preventDefault();
                            client.skipStagedFile(head.id);
                        }
                    }}
                    aria-label="Caption"
                />
            </div>
            <footer className="mj_UploadConfirm_footer mj_UploadConfirm_actions">
                {staged.total > 1 && (
                    <button
                        className="mj_TextButton"
                        aria-label="Cancel all"
                        disabled={staged.confirming}
                        onClick={() => client.cancelStagedFiles()}
                    >
                        Cancel all
                    </button>
                )}
                <button
                    className="mj_UploadConfirm_skip"
                    aria-label="Skip"
                    disabled={staged.confirming}
                    onClick={() => client.skipStagedFile(head.id)}
                >
                    Skip
                </button>
                <button className="mj_UploadConfirm_send" aria-label="Send" disabled={!canSend} onClick={send}>
                    Send
                </button>
            </footer>
        </div>
    );
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
    // #531: in child view the escape names its destination — look up the parent conversation.
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
                        <span className="mj_SubagentBack_name">{conversationTitle(parent)}</span>
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
                        const isRunning = child.session_state === "running";
                        const className = [
                            "mj_SubagentPill",
                            !isRunning && "mj_SubagentPill_finished",
                            isCurrent && "mj_SubagentPill_current",
                        ]
                            .filter(Boolean)
                            .join(" ");
                        return (
                            <div key={child.id} role="listitem" className="mj_SubagentPill_wrapper">
                                <button
                                    className={className}
                                    aria-label={`Open subagent ${conversationTitle(child)}`}
                                    aria-current={isCurrent ? "true" : undefined}
                                    disabled={isCurrent}
                                    onClick={() => void client.selectConversation(child.id)}
                                >
                                    {isRunning ? (
                                        <span className="mj_Spinner" aria-hidden="true" />
                                    ) : (
                                        <CheckIcon className="mj_SubagentPill_icon" aria-hidden="true" />
                                    )}
                                    <span className="mj_SubagentPill_name">{conversationTitle(child)}</span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function SignedInApp({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const leftPanel = useLeftPanelResize();
    const [dragActive, setDragActive] = useState(state.dragActive);
    const [draftReloadTicks, setDraftReloadTicks] = useState<Record<string, number>>({});
    const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
    // Meter count drives the usage collapse threshold: the synthetic ctx bar + each
    // non-blank limit. >4 (host cpu/ram present) needs the wider pane before the 3-column
    // grid renders inline instead of collapsing to the popover.
    const meterCount =
        (state.sessionStatus?.context ? 1 : 0) +
        (state.sessionStatus?.limits?.filter((limit) => limit.label.trim()).length ?? 0);
    const collapse = useAdaptiveHeader(bodyEl, meterCount);
    const appContent = useRef<HTMLDivElement>(null);
    const uploadDialogWasOpen = useRef(Boolean(state.stagedUploads));
    const drafts = useMemo(() => makeDraftStore(state.session), [state.session]);
    const sendingConvos = useRef<Set<string>>(new Set());
    const draftRevisions = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        if (uploadDialogWasOpen.current && !state.stagedUploads) {
            appContent.current?.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input")?.focus();
        }
        uploadDialogWasOpen.current = Boolean(state.stagedUploads);
    }, [state.stagedUploads]);

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
            if (state.stagedUploads) return; // upload / new-session modal owns Escape
            // Any inner overlay still mounted → it owns this press; defer.
            if (
                document.querySelector(
                    ".mj_EventSource_scrim, .mj_UploadConfirm_scrim, .mj_NewSessionSheet, .mj_AccountMenu, .mj_EventRowMenu, .mj_RoomItemMenu, .mj_HeaderMenu, [role='menu']",
                )
            ) {
                return;
            }
            event.preventDefault();
            void client.selectConversation(parentId);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [hasParent, parentId, state.stagedUploads, client]);

    return (
        <div className="mx_MatrixChat_wrapper">
            <div ref={appContent} className="mx_MatrixChat" inert={state.stagedUploads ? true : undefined}>
                <ConversationList client={client} state={state} width={leftPanel.width} />
                <div
                    className="mx_ResizeHandle mx_ResizeHandle--horizontal"
                    data-id="lp-resizer"
                    onPointerDown={leftPanel.onPointerDown}
                >
                    <div />
                </div>
                <div className={`mx_RoomView_wrapper ${state.selectedConversationId ? "" : "mj_Chat_mobileHidden"}`}>
                    {state.selectedConversationId ? (
                        <div
                            className={`mx_RoomView${dragActive ? " mj_RoomView_dragActive" : ""}`}
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
                                if (state.stagedUploads) return;
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
                            <div
                                ref={setBodyEl}
                                className="mx_RoomView_body mx_MainSplit_timeline"
                                data-layout="bubble"
                            >
                                {childMode ? (
                                    <SubChatHeader client={client} state={state} collapse={collapse} />
                                ) : (
                                    <ChatHeader client={client} state={state} collapse={collapse} />
                                )}
                                <SubagentStrip client={client} state={state} mode={childMode ? "child" : "parent"} />
                                <Timeline client={client} state={state} isReadOnly={childMode} />
                                {childMode ? (
                                    <ReadOnlyHint />
                                ) : (
                                    <Composer
                                        client={client}
                                        state={state}
                                        drafts={drafts}
                                        draftReloadTick={draftReloadTicks[state.selectedConversationId] ?? 0}
                                        reloadDraft={(conversationId) =>
                                            setDraftReloadTicks((ticks) => ({
                                                ...ticks,
                                                [conversationId]: (ticks[conversationId] ?? 0) + 1,
                                            }))
                                        }
                                        sendingConvos={sendingConvos}
                                        draftRevisions={draftRevisions}
                                    />
                                )}
                            </div>
                        </div>
                    ) : (
                        <main className="mx_HomePage mx_HomePage_default">
                            <div className="mx_HomePage_default_wrapper">
                                <img src={matronLogo} alt={state.config.brand || "Matron"} />
                                <h1>Welcome to {state.config.brand || "Matron"}</h1>
                            </div>
                        </main>
                    )}
                </div>
            </div>
            {state.stagedUploads && <UploadConfirmDialog client={client} staged={state.stagedUploads} />}
        </div>
    );
}

export function MatronApp({ client }: { client: MatronJournalClient }): React.ReactElement {
    const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
    if (state.phase === "loading")
        return (
            <div className="mx_MatrixChat_splash mj_Loading">
                <img src={matronLogo} alt="Matron" />
            </div>
        );
    if (state.phase === "signed-out") return <LoginScreen client={client} state={state} />;
    return <SignedInApp client={client} state={state} />;
}
