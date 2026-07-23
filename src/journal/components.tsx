/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, {
    type FormEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";

import matronLogo from "../../res/matron-logo-simple.svg";
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
    ChevronLeftIcon,
    CloseIcon,
    CompactIcon,
    ComposeIcon,
    FileEditIcon,
    KebabIcon,
    MarkAllReadIcon,
    MarkReadIcon,
    MarkUnreadIcon,
    MicOnIcon,
    PinIcon,
    ReactionIcon,
    SearchIcon,
    SendIcon,
    SettingsIcon,
    StarFilledIcon,
    StarIcon,
    UnarchiveIcon,
} from "./icons";
import { createLongPressController, type LongPressController } from "./longPress";
import { MarkdownBody } from "./markdown";
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
import { compactTokens, resetDisplay, usageBarLabel, usageLevel } from "./status";
import {
    asNumber,
    asString,
    childrenOf,
    type ClientState,
    conversationTitle,
    type DeviceDTO,
    displaySender,
    type EventPayload,
    isNearBottom,
    type JournalEvent,
    type PendingMessage,
    parentPresent,
    type RecentFolder,
    runningChildrenOf,
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
    const storedWidth = Number.parseInt(window.localStorage.getItem(LEFT_PANEL_SIZE_KEY) ?? "", 10);
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
            window.localStorage.setItem(LEFT_PANEL_SIZE_KEY, String(Math.round(widthRef.current)));
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

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
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
            <div className="mj_UploadConfirm">
                <div className="mj_UploadConfirm_actions">
                    <h2 className="mj_UploadConfirm_title" id="mj-new-session-title">
                        New session
                    </h2>
                    <button type="button" aria-label="Close" onClick={dismiss}>
                        Close
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
    const [tab, setTab] = useState<"all" | "favorites">("all");
    const [accountOpen, setAccountOpen] = useState(false);
    const [newSessionOpen, setNewSessionOpen] = useState(false);
    const [archivedExpanded, setArchivedExpanded] = useState(false);
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
    const ids = new Set(
        state.conversations
            .filter((conversation) => !state.archivedIds.has(conversation.id))
            .map((conversation) => conversation.id),
    );
    const conversations = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return state.conversations
            .filter((conversation) => !parentPresent(conversation, ids))
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
    const visibleActive =
        tab === "favorites" ? active.filter((conversation) => state.favoriteIds.has(conversation.id)) : active;
    const hasAnyFavorite = state.conversations.some(
        (conversation) =>
            state.favoriteIds.has(conversation.id) &&
            !state.archivedIds.has(conversation.id) &&
            !parentPresent(conversation, ids),
    );
    const archived = conversations.filter((conversation) => state.archivedIds.has(conversation.id));
    // Visibility is computed from the UNFILTERED conversation set (minus archived), NOT the
    // search-filtered `active` — mark-all operates on the full active partition regardless of
    // the search box, so the button must not vanish just because the search hides the unread rows.
    const hasActiveUnread = state.conversations.some(
        (conversation) =>
            effectiveUnread(conversation, state.unreadOverrideIds) &&
            !state.archivedIds.has(conversation.id) &&
            !parentPresent(conversation, ids),
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

    const renderConversation = (conversation: ClientState["conversations"][number]): React.ReactElement => {
        const selected = state.selectedConversationId === conversation.id;
        const overrideUnread = state.unreadOverrideIds.has(conversation.id) && conversation.unread_count === 0;
        const unread = effectiveUnread(conversation, state.unreadOverrideIds);
        const name = conversationTitle(conversation);
        return (
            <div className="mj_RoomListItem_wrapper" role="listitem" key={conversation.id}>
                <button
                    className={`mj_RoomListItem${selected ? " mj_RoomListItem_selected" : ""}`}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    aria-label={`Open room ${name}${overrideUnread ? ", marked unread" : ""}`}
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
                    {state.pinnedIds.has(conversation.id) && (
                        <span className="mj_RoomListPinGlyph">
                            <PinIcon aria-hidden />
                        </span>
                    )}
                    <span className={`mj_RoomListText${unread ? " mj_RoomListText_unread" : ""}`}>
                        <span className="mj_RoomListName" title={name} data-testid="room-name">
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
                    {conversation.unread_count > 0 ? (
                        <span className="mj_UnreadBadge" aria-label={`${conversation.unread_count} unread`}>
                            {conversation.unread_count}
                        </span>
                    ) : overrideUnread ? (
                        <span className="mj_UnreadDot" aria-hidden />
                    ) : null}
                </button>
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
                                    <h1 title="Home">Home</h1>
                                    <div className="mj_RoomListHeaderActions">
                                        {hasActiveUnread && (
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
                                        <button
                                            className="mj_IconButton"
                                            type="button"
                                            aria-label="New conversation"
                                            onClick={() => {
                                                setAccountOpen(false);
                                                closeRoomMenu();
                                                setNewSessionOpen(true);
                                            }}
                                        >
                                            <ComposeIcon />
                                        </button>
                                    </div>
                                </header>
                                <div className="mj_RoomListTabs" aria-label="Filter conversations">
                                    <button
                                        type="button"
                                        className={`mj_RoomListTab${tab === "all" ? " mj_RoomListTab_active" : ""}`}
                                        aria-pressed={tab === "all"}
                                        onClick={(event) => {
                                            setTab("all");
                                            event.currentTarget.focus({ preventScroll: true });
                                        }}
                                    >
                                        All
                                    </button>
                                    <button
                                        type="button"
                                        className={`mj_RoomListTab${tab === "favorites" ? " mj_RoomListTab_active" : ""}`}
                                        aria-pressed={tab === "favorites"}
                                        onClick={(event) => {
                                            setTab("favorites");
                                            event.currentTarget.focus({ preventScroll: true });
                                        }}
                                    >
                                        Favorites
                                    </button>
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
                                    {visibleActive.map((conversation) => renderConversation(conversation))}
                                    {tab === "favorites" && !hasAnyFavorite && (
                                        <p className="mj_RoomListEmpty">No favorite conversations yet.</p>
                                    )}
                                    {tab === "favorites" && hasAnyFavorite && !visibleActive.length && (
                                        <p className="mj_RoomListEmpty">No favorites match your search.</p>
                                    )}
                                    {tab === "all" && !active.length && !archived.length && (
                                        <p className="mj_RoomListEmpty">Your agent conversations will appear here.</p>
                                    )}
                                </div>
                                {tab === "all" && archived.length > 0 && (
                                    <>
                                        <button
                                            className="mj_RoomList_archivedToggle"
                                            type="button"
                                            aria-expanded={archivedExpanded}
                                            aria-controls="mj-room-list-archived"
                                            onClick={() => setArchivedExpanded((expanded) => !expanded)}
                                        >
                                            Archived{" "}
                                            <span className="mj_RoomList_archivedCount">({archived.length})</span>
                                        </button>
                                        {archivedExpanded && (
                                            <div
                                                id="mj-room-list-archived"
                                                className="mj_RoomList_archivedSection"
                                                role="list"
                                                aria-label="Archived conversations"
                                            >
                                                {archived.map((conversation) => renderConversation(conversation))}
                                            </div>
                                        )}
                                    </>
                                )}
                            </nav>
                        </div>
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

function useMinuteClock(): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, []);
    return now;
}

function UsageBars({ limits }: { limits: NonNullable<SessionStatus["limits"]> }): React.ReactElement {
    const now = useMinuteClock();
    return (
        <div className="mj_UsageBars" role="group" aria-label="Usage limits">
            {limits.slice(0, 3).map((limit) => {
                const percent = Math.min(Math.max(limit.percent, 0), 100);
                const reset = resetDisplay(limit.resets_at, limit.resets, now);
                return (
                    <div className="mj_UsageRow" key={limit.label} title={reset ? `resets ${reset}` : undefined}>
                        <span className="mj_UsageLabel">{usageBarLabel(limit.label)}:</span>
                        <span
                            className="mj_UsageTrack"
                            role="progressbar"
                            aria-label={usageBarLabel(limit.label)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                            aria-valuetext={`${percent}% used${reset ? `, resets ${reset}` : ""}`}
                        >
                            <span
                                className={`mj_UsageFill mj_UsageFill_${usageLevel(percent)}`}
                                style={{ width: `${percent}%` }}
                            />
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function ChatHeader({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const conversation = client.selectedConversation();
    const title = conversation ? conversationTitle(conversation) : "Conversation";
    const children = childrenOf(state.conversations, conversation?.id);
    const [subagentsOpen, setSubagentsOpen] = useState(false);
    const status = state.sessionStatus;
    const hasModelContext = Boolean(status?.model || status?.context);
    const limits = status?.limits?.filter((limit) => limit.label.trim());
    return (
        <header className="mx_RoomHeader light-panel mj_ChatHeader">
            <button
                className="mj_BackButton"
                onClick={() => client.clearSelection()}
                aria-label="Back to conversations"
            >
                <ChevronLeftIcon />
            </button>
            <div
                className={`mj_HeaderCluster mj_ModelContextCluster${hasModelContext ? "" : " mj_HeaderCluster_empty"}`}
                aria-hidden={!hasModelContext}
            >
                {status?.model && <span className="mj_HeaderModel">{status.model}</span>}
                {status?.context && (
                    <span className="mj_HeaderContextRow">
                        <span
                            className="mj_HeaderContext"
                            title={`${status.context.tokens.toLocaleString()} / ${status.context.window.toLocaleString()} tokens`}
                        >
                            Context: {compactTokens(status.context.tokens)}/{compactTokens(status.context.window)}
                        </span>
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
                        </button>
                    </span>
                )}
            </div>
            <div className="mj_HeaderCluster mj_HeaderTitleCluster">
                <div dir="auto" role="heading" aria-level={1} className="mx_RoomHeader_heading">
                    <span className="mx_RoomHeader_truncated mx_lineClamp">{title}</span>
                </div>
                {status?.email && (
                    <span className="mj_HeaderEmail" title={status.email}>
                        {status.email}
                    </span>
                )}
                {children.length > 0 && (
                    <div className="mj_SubagentSwitcher">
                        <button
                            type="button"
                            className="mj_SubagentSwitcherButton"
                            aria-haspopup="menu"
                            aria-expanded={subagentsOpen}
                            onClick={() => setSubagentsOpen((open) => !open)}
                        >
                            {children.length} {children.length === 1 ? "subagent" : "subagents"} ▾
                        </button>
                        {subagentsOpen && (
                            <div className="mj_HeaderMenu mj_SubagentSwitcherMenu" role="menu">
                                {children.map((child) => (
                                    <button
                                        key={child.id}
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setSubagentsOpen(false);
                                            void client.selectConversation(child.id);
                                        }}
                                    >
                                        <span aria-hidden="true">{child.session_state === "running" ? "●" : "○"}</span>{" "}
                                        {conversationTitle(child)}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
            <div
                className={`mj_HeaderCluster mj_UsageCluster${limits?.length ? "" : " mj_HeaderCluster_empty"}`}
                aria-hidden={!limits?.length}
            >
                {limits?.length ? <UsageBars limits={limits} /> : null}
            </div>
        </header>
    );
}

function SubChatHeader({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const selected = client.selectedConversation();
    const siblings = childrenOf(state.conversations, selected?.parent_convo_id);
    const [siblingsOpen, setSiblingsOpen] = useState(false);
    const status = state.sessionStatus;
    const hasModelContext = Boolean(status?.model || status?.context);
    const limits = status?.limits?.filter((limit) => limit.label.trim());
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
        <header className="mx_RoomHeader light-panel mj_ChatHeader mj_SubChatHeader">
            <button type="button" className="mj_BackButton" onClick={goBack} aria-label="Back to parent">
                <ChevronLeftIcon />
            </button>
            <div
                className={`mj_HeaderCluster mj_ModelContextCluster${hasModelContext ? "" : " mj_HeaderCluster_empty"}`}
                aria-hidden={!hasModelContext}
            >
                {status?.model && <span className="mj_HeaderModel">{status.model}</span>}
                {status?.context && (
                    <span
                        className="mj_HeaderContext"
                        title={`${status.context.tokens.toLocaleString()} / ${status.context.window.toLocaleString()} tokens`}
                    >
                        Context: {compactTokens(status.context.tokens)}/{compactTokens(status.context.window)}
                    </span>
                )}
            </div>
            <div className="mj_HeaderCluster mj_HeaderTitleCluster">
                <div dir="auto" role="heading" aria-level={1} className="mx_RoomHeader_heading">
                    <span className="mx_RoomHeader_truncated mx_lineClamp">
                        {selected ? conversationTitle(selected) : "Subagent"}
                    </span>
                </div>
                <span className="mj_SubChatState">
                    {selected?.session_state === "running" && <span className="mj_Spinner" aria-hidden="true" />}
                    {selected?.session_state === "running" ? "Running" : "Finished"}
                </span>
                {siblings.length > 1 && (
                    <div className="mj_SubagentSwitcher">
                        <button
                            type="button"
                            className="mj_SubagentSwitcherButton"
                            aria-haspopup="menu"
                            aria-expanded={siblingsOpen}
                            onClick={() => setSiblingsOpen((open) => !open)}
                        >
                            {siblings.length} subagents ▾
                        </button>
                        {siblingsOpen && (
                            <div className="mj_HeaderMenu mj_SubagentSwitcherMenu" role="menu">
                                {siblings.map((sibling) => {
                                    const isCurrent = sibling.id === selected?.id;
                                    const glyph = isCurrent ? "✓" : sibling.session_state === "running" ? "●" : "○";
                                    return (
                                        <button
                                            key={sibling.id}
                                            type="button"
                                            role="menuitem"
                                            disabled={isCurrent}
                                            onClick={() => {
                                                setSiblingsOpen(false);
                                                void client.selectConversation(sibling.id);
                                            }}
                                        >
                                            <span aria-hidden="true">{glyph}</span> {conversationTitle(sibling)}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
            <div
                className={`mj_HeaderCluster mj_UsageCluster${limits?.length ? "" : " mj_HeaderCluster_empty"}`}
                aria-hidden={!limits?.length}
            >
                {limits?.length ? <UsageBars limits={limits} /> : null}
            </div>
        </header>
    );
}

function ReadOnlyHint(): React.ReactElement {
    return <div className="mj_ReadOnlyHint">Read-only — subagent transcript</div>;
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

    return (
        <div className="mj_PromptCard">
            <div className="mj_PromptLabel">{permission ? "Permission needed" : "Question"}</div>
            <p>{question}</p>
            {!isReadOnly && !disabled && options.length > 0 && (
                <div className="mj_PromptOptions">
                    {options.map((option) => (
                        <button key={`${option.label}:${option.value}`} onClick={() => answer(option.value)}>
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
                    <button type="submit" disabled={!freeText.trim()}>
                        Send
                    </button>
                </form>
            )}
            {disabled && <div className="mj_Answered">✓ Answered</div>}
        </div>
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
                <span aria-hidden="true">{failed ? "!" : "›_"}</span>
                <code>{command.split(/\s+/)[0] || "tool"}</code>
                <span>{failed ? "Failed" : "Completed"}</span>
                {exitCode !== undefined && <span>exit {exitCode}</span>}
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
                {visibleLines.map((line, index) => (
                    <div className={lineClass(line)} key={`${index}:${line}`}>
                        {line}
                    </div>
                ))}
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

// Queue-tile control tokens (⚡ Send now / ✕ Cancel) arrive as prompt_reply
// events whose `choice` is a bridge wire value (`interrupt` / `cancel:<n>`,
// lib/busy-queue.js isQueueActionValue). They are control signals, not chat
// messages: the bridge acts on them and suppresses its own "answered:" echo, so
// the client must not render the raw token as a visible bubble either — the
// timeline filters these out (loop #490). The values are bridge-controlled
// constants, which is what makes shape-matching safe here (the same argument
// the bridge uses). Scoped to queue actions only — a normal answer's bubble and
// the answered-prompt state (answeredPrompts, which still counts these so the
// queue tile shows answered/disabled) are untouched.
export function isQueueActionReply(event: JournalEvent): boolean {
    if (event.type !== "prompt_reply") return false;
    const choice = asString(event.payload.choice);
    return choice === "interrupt" || /^cancel:\d+$/.test(choice);
}

export function EventContent({
    client,
    event,
    answeredPrompts,
    isReadOnly = false,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPrompts: Set<number>;
    isReadOnly?: boolean;
}): React.ReactElement {
    switch (event.type) {
        case "text":
            return (
                <div className="mj_Markdown">
                    <MarkdownBody text={asString(event.payload.body)} label={String(event.seq)} />
                </div>
            );
        case "prompt":
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
    continuation = false,
    lastInSection = true,
    rowHandlers,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPrompts: Set<number>;
    isReadOnly?: boolean;
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
                    <span className="mx_DisambiguatedProfile_displayName">{displaySender(event.sender)}</span>
                </span>
            )}
            <div className="mx_EventTile_line">
                <a href={`#event-${event.seq}`} onClick={(clickEvent) => clickEvent.preventDefault()}>
                    <time className="mx_MessageTimestamp" dateTime={new Date(event.ts).toISOString()}>
                        {formatTime(event.ts)}
                    </time>
                </a>
                <div className="mx_MTextBody mx_EventTile_content">
                    <div className="markdown-body">
                        <EventContent
                            client={client}
                            event={event}
                            answeredPrompts={answeredPrompts}
                            isReadOnly={isReadOnly}
                        />
                    </div>
                </div>
            </div>
        </li>
    );
}

function ToolStream({ stream }: { stream: ToolStreamState }): React.ReactElement {
    return (
        <li className="mx_EventTile mx_EventTile_lastInSection" tabIndex={-1} data-layout="bubble" data-self="false">
            <span className="mx_DisambiguatedProfile">
                <span className="mx_DisambiguatedProfile_displayName">agent</span>
            </span>
            <div className="mx_EventTile_line">
                <div className="mx_MTextBody mx_EventTile_content">
                    <div className="markdown-body mj_LiveTool">
                        <div>
                            <span className="mj_LiveDot" /> Running{" "}
                            <code>{stream.command || stream.tool || "tool"}</code>
                        </div>
                        <pre>
                            {stream.headTruncated ? `… earlier output omitted …\n${stream.content}` : stream.content}
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
    const visibleEvents = useMemo(
        () =>
            state.events.filter(
                (event) =>
                    !["read_marker", "edit", "session_status", "convo_meta"].includes(event.type) &&
                    !isQueueActionReply(event),
            ),
        [state.events],
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
                            if (item.kind === "event") {
                                const previous = timeline[index - 1];
                                const next = timeline[index + 1];
                                return (
                                    <EventRow
                                        key={item.event.seq}
                                        client={client}
                                        event={item.event}
                                        answeredPrompts={answeredPrompts}
                                        isReadOnly={isReadOnly}
                                        continuation={
                                            previous?.kind === "event" && previous.event.sender === item.event.sender
                                        }
                                        lastInSection={
                                            next?.kind !== "event" || next.event.sender !== item.event.sender
                                        }
                                        rowHandlers={menu.rowHandlers}
                                    />
                                );
                            }
                            const message = item.message;
                            return message.kind === "image" || message.kind === "file" ? (
                                <PendingAttachment
                                    key={message.localId}
                                    client={client}
                                    message={message}
                                    isReadOnly={isReadOnly}
                                />
                            ) : (
                                <li
                                    className="mx_EventTile mx_EventTile_sending mx_EventTile_lastInSection"
                                    key={message.localId}
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
                        <button
                            className="mj_RoomItemMenu_item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                void copyText(asString(menu.state!.target.payload.body));
                                menu.close();
                            }}
                        >
                            Copy
                        </button>
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
                        View source
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
    const store = useMemo(() => makeRecentFoldersStore(state.session), [state.session]);
    const [dismissedSeq, setDismissedSeq] = useState(0);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const convoId = state.selectedConversationId;
    const convoIdRef = useRef(convoId);
    convoIdRef.current = convoId;
    const prevConvoIdRef = useRef(convoId);
    const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const folders = folderSuggestions(body, store);
    const commands = filterCommands(CLAUDE_BRIDGE_COMMANDS, body);
    const open = body !== dismissed && (folders.length > 0 || (isCommandMode(body) && commands.length > 0));

    const cancelDraftDebounce = useCallback(() => {
        if (draftTimerRef.current) {
            clearTimeout(draftTimerRef.current);
            draftTimerRef.current = undefined;
        }
    }, []);
    const flushDraft = useCallback(() => {
        cancelDraftDebounce();
        drafts.persist();
    }, [cancelDraftDebounce, drafts]);

    const setBodyDraft = useCallback(
        (next: string) => {
            setBody(next);
            const cid = convoIdRef.current;
            if (!cid) return;
            draftRevisions.current.set(cid, (draftRevisions.current.get(cid) ?? 0) + 1);
            drafts.setDraft(cid, next);
            if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
            draftTimerRef.current = setTimeout(() => {
                drafts.persist();
                draftTimerRef.current = undefined;
            }, 250);
        },
        [draftRevisions, drafts],
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
                cancelDraftDebounce();
                const draftUnchanged = (draftRevisions.current.get(cid) ?? 0) === submittedRevision;
                if (draftUnchanged) drafts.clear(cid);
                else drafts.persist();
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
    return (
        <div className="mx_MessageComposer" role="region" aria-label="Message composer">
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
                <div className="mx_MessageComposer_row">
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
                                            setHighlighted((current) => (current === null ? 0 : (current + 1) % count));
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
                                role="combobox"
                                aria-expanded={open}
                                aria-controls={SLASH_LISTBOX_ID}
                                aria-activedescendant={highlighted !== null ? slashRowId(highlighted) : undefined}
                            />
                        </div>
                    </div>
                    <div className="mx_MessageComposer_actions">
                        <button className="mx_MessageComposer_button mx_EmojiButton" title="Emoji" aria-label="Emoji">
                            <ReactionIcon />
                        </button>
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
                        <button
                            className="mx_MessageComposer_button"
                            title="Voice messages are not supported by this journal server"
                            aria-label="Voice message"
                            aria-disabled="true"
                        >
                            <MicOnIcon />
                        </button>
                        {body.trim() && (
                            <button
                                className="mx_MessageComposer_sendMessage"
                                onClick={() => void send()}
                                aria-label="Send message"
                            >
                                <SendIcon />
                            </button>
                        )}
                    </div>
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
                    <h2>Event source</h2>
                </header>
                <pre className="mj_EventSource_json">{json}</pre>
                <div className="mj_EventSource_actions">
                    <button type="button" onClick={() => void copyText(json)}>
                        Copy
                    </button>
                    <button type="button" ref={doneRef} onClick={onClose}>
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
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
        <div className="mj_UploadConfirm">
            <h2 className="mj_UploadConfirm_title">
                {head.file.name}
                {staged.total > 1 && (
                    <span className="mj_UploadConfirm_count">
                        {" "}
                        — File {position} of {staged.total}
                    </span>
                )}
            </h2>
            {isImage && previewUrl ? (
                <img className="mj_UploadConfirm_preview" src={previewUrl} alt={head.file.name} />
            ) : (
                <div className="mj_UploadConfirm_fileMeta">
                    <AttachmentIcon />
                    <span>{head.file.name}</span>
                    <span className="mj_FileSize">{formatBytes(head.file.size)}</span>
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
            <div className="mj_UploadConfirm_actions">
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
                <button aria-label="Cancel" disabled={staged.confirming} onClick={() => client.skipStagedFile(head.id)}>
                    Cancel
                </button>
                <button className="mj_UploadConfirm_send" aria-label="Send" disabled={!canSend} onClick={send}>
                    Send
                </button>
            </div>
        </div>
    );
}

function RunningSubagentStrip({
    client,
    state,
}: {
    client: MatronJournalClient;
    state: ClientState;
}): React.ReactElement | null {
    const running = runningChildrenOf(state.conversations, state.selectedConversationId);
    if (running.length === 0) return null;
    return (
        <div className="mj_SubagentStrip" role="list">
            {running.map((child) => (
                <button
                    key={child.id}
                    className="mj_SubagentPill"
                    role="listitem"
                    aria-label={`Open subagent ${conversationTitle(child)}`}
                    onClick={() => void client.selectConversation(child.id)}
                >
                    <span className="mj_Spinner" aria-hidden="true" />
                    {conversationTitle(child)}
                </button>
            ))}
        </div>
    );
}

function SignedInApp({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const leftPanel = useLeftPanelResize();
    const [dragActive, setDragActive] = useState(state.dragActive);
    const [draftReloadTicks, setDraftReloadTicks] = useState<Record<string, number>>({});
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
                            <div className="mx_RoomView_body mx_MainSplit_timeline" data-layout="bubble">
                                {childMode ? (
                                    <SubChatHeader client={client} state={state} />
                                ) : (
                                    <ChatHeader client={client} state={state} />
                                )}
                                <RunningSubagentStrip client={client} state={state} />
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
