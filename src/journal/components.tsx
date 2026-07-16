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
import { errorMessage, type MatronJournalClient } from "./client";
import {
    AttachmentIcon,
    ChevronLeftIcon,
    ComposeIcon,
    MicOnIcon,
    ReactionIcon,
    SearchIcon,
    SendIcon,
    SettingsIcon,
} from "./icons";
import { compactTokens, resetDisplay, usageBarLabel, usageLevel } from "./status";
import {
    asNumber,
    asString,
    type ClientState,
    conversationTitle,
    displaySender,
    type EventPayload,
    type JournalEvent,
    type SessionStatus,
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
        <div className="mx_AuthPage" style={{ background: "#fbfaf6" }}>
            <div className="mx_AuthPage_modal mx_AuthPage_modal_withBlur" style={{ position: "relative" }}>
                <div
                    className="mx_AuthPage_modalBlur"
                    style={{ position: "absolute", inset: 0, filter: "blur(40px)", background: "#fbfaf6" }}
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
    const [accountOpen, setAccountOpen] = useState(false);
    const [composeHint, setComposeHint] = useState(false);
    const conversations = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        return state.conversations.filter(
            (conversation) =>
                !normalized ||
                `${conversation.title} ${conversation.id} ${conversation.snippet}`
                    .toLocaleLowerCase()
                    .includes(normalized),
        );
    }, [query, state.conversations]);

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
                                        <button
                                            className="mj_IconButton"
                                            type="button"
                                            aria-label="Settings"
                                            onClick={() => {
                                                setComposeHint(false);
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
                                                setComposeHint((open) => !open);
                                            }}
                                        >
                                            <ComposeIcon />
                                        </button>
                                    </div>
                                </header>
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
                                <div
                                    className="mj_RoomList"
                                    data-testid="room-list"
                                    role="listbox"
                                    aria-label="Conversations"
                                >
                                    {conversations.length ? (
                                        conversations.map((conversation, index) => {
                                            const selected = state.selectedConversationId === conversation.id;
                                            const unread = conversation.unread_count > 0;
                                            const name = conversationTitle(conversation);
                                            return (
                                                <button
                                                    className={`mj_RoomListItem${selected ? " mj_RoomListItem_selected" : ""}`}
                                                    type="button"
                                                    role="option"
                                                    aria-posinset={index + 1}
                                                    aria-setsize={conversations.length}
                                                    aria-selected={selected}
                                                    aria-label={`Open room ${name}`}
                                                    key={conversation.id}
                                                    onClick={() => void client.selectConversation(conversation.id)}
                                                >
                                                    <span
                                                        className={`mj_RoomListText${unread ? " mj_RoomListText_unread" : ""}`}
                                                    >
                                                        <span
                                                            className="mj_RoomListName"
                                                            title={name}
                                                            data-testid="room-name"
                                                        >
                                                            {name}
                                                        </span>
                                                        <span
                                                            className="mj_RoomListPreview"
                                                            title={conversation.snippet}
                                                        >
                                                            {conversation.snippet}
                                                        </span>
                                                    </span>
                                                    {unread && (
                                                        <span
                                                            className="mj_UnreadBadge"
                                                            aria-label={`${conversation.unread_count} unread`}
                                                        >
                                                            {conversation.unread_count}
                                                        </span>
                                                    )}
                                                </button>
                                            );
                                        })
                                    ) : (
                                        <p className="mj_RoomListEmpty">Your agent conversations will appear here.</p>
                                    )}
                                </div>
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
                {composeHint && (
                    <div className="mj_HeaderMenu mj_ComposeHint">
                        New conversations appear when an agent starts a session.
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
        <div className="mj_UsageBars" aria-label="Usage limits">
            {limits.slice(0, 3).map((limit) => {
                const percent = Math.min(Math.max(limit.percent, 0), 100);
                const reset = resetDisplay(limit.resets_at, limit.resets, now);
                return (
                    <div
                        className="mj_UsageRow"
                        key={limit.label}
                        aria-label={`${usageBarLabel(limit.label)}, ${percent}% used${reset ? `, resets ${reset}` : ""}`}
                    >
                        <span className="mj_UsageLabel">{usageBarLabel(limit.label)}:</span>
                        <span
                            className="mj_UsageTrack"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                        >
                            <span
                                className={`mj_UsageFill mj_UsageFill_${usageLevel(percent)}`}
                                style={{ width: `${percent}%` }}
                            />
                        </span>
                        <span className="mj_UsageReset">{reset}</span>
                    </div>
                );
            })}
        </div>
    );
}

function ChatHeader({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const conversation = client.selectedConversation();
    const title = conversation ? conversationTitle(conversation) : "Conversation";
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
                    <span className="mx_RoomHeader_truncated mx_lineClamp">{title}</span>
                </div>
                {status?.email && (
                    <span className="mj_HeaderEmail" title={status.email}>
                        {status.email}
                    </span>
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

function PromptCard({
    client,
    event,
    answered,
    permission = false,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answered: boolean;
    permission?: boolean;
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
            {!disabled && options.length > 0 && (
                <div className="mj_PromptOptions">
                    {options.map((option) => (
                        <button key={`${option.label}:${option.value}`} onClick={() => answer(option.value)}>
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
            {!disabled && (event.payload.allows_free_text === true || options.length === 0) && (
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

function EventContent({
    client,
    event,
    answeredPrompts,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPrompts: Set<number>;
}): React.ReactElement {
    switch (event.type) {
        case "text":
            return <div className="mj_MessageText">{asString(event.payload.body)}</div>;
        case "prompt":
            return <PromptCard client={client} event={event} answered={answeredPrompts.has(event.seq)} />;
        case "permission_request":
            return <PromptCard client={client} event={event} answered={answeredPrompts.has(event.seq)} permission />;
        case "prompt_reply":
            return (
                <div className="mj_MessageText">
                    {asString(event.payload.choice, asString(event.payload.text, "Answered"))}
                </div>
            );
        case "tool_output":
            return <ToolOutput client={client} event={event} />;
        case "diff":
            return (
                <pre className="mj_Diff">
                    {asString(
                        event.payload.diff,
                        asString(event.payload.patch, JSON.stringify(event.payload, null, 2)),
                    )}
                </pre>
            );
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
    continuation = false,
    lastInSection = true,
}: {
    client: MatronJournalClient;
    event: JournalEvent;
    answeredPrompts: Set<number>;
    continuation?: boolean;
    lastInSection?: boolean;
}): React.ReactElement {
    const own = event.sender.startsWith("user:");
    return (
        <li
            className={`mx_EventTile${continuation ? " mx_EventTile_continuation" : ""}${lastInSection ? " mx_EventTile_lastInSection" : ""}`}
            tabIndex={-1}
            aria-live="polite"
            aria-atomic="true"
            data-layout="bubble"
            data-self={own}
            data-event-id={event.seq}
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
                        <EventContent client={client} event={event} answeredPrompts={answeredPrompts} />
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

function Timeline({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const scrollRef = useRef<HTMLDivElement>(null);
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
                (event) => !["read_marker", "edit", "session_status", "convo_meta"].includes(event.type),
            ),
        [state.events],
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

        node.scrollTop = node.scrollHeight;
    }, [
        state.selectedConversationId,
        visibleEvents,
        state.pendingMessages.length,
        state.textStreams,
        state.toolStreams,
        state.loadingHistory,
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
            <div className="mx_RoomView_messagePanel mx_AutoHideScrollbar" ref={scrollRef}>
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
                        {visibleEvents.map((event, index) => (
                            <EventRow
                                key={event.seq}
                                client={client}
                                event={event}
                                answeredPrompts={answeredPrompts}
                                continuation={index > 0 && visibleEvents[index - 1].sender === event.sender}
                                lastInSection={
                                    index === visibleEvents.length - 1 ||
                                    visibleEvents[index + 1].sender !== event.sender
                                }
                            />
                        ))}
                        {state.pendingMessages.map((message) => (
                            <li
                                className="mx_EventTile mx_EventTile_sending mx_EventTile_lastInSection"
                                key={message.localId}
                                data-layout="bubble"
                                data-self="true"
                            >
                                <div className="mx_EventTile_line">
                                    <div className="mx_MTextBody mx_EventTile_content">
                                        <div className="markdown-body mj_MessageText">{message.body}</div>
                                    </div>
                                </div>
                                <span className="mj_SendingLabel">Sending…</span>
                            </li>
                        ))}
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
                                        <div className="markdown-body mj_MessageText">
                                            {text}
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
        </main>
    );
}

function Composer({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const [body, setBody] = useState("");
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const send = async (): Promise<void> => {
        if (await client.sendMessage(body)) {
            setBody("");
            if (textarea.current) textarea.current.style.height = "auto";
        }
    };
    return (
        <div className="mx_MessageComposer" role="region" aria-label="Message composer">
            <div className="mx_MessageComposer_wrapper">
                {state.connectionError && (
                    <div className="mj_ConnectionError" role="status">
                        {state.connectionError}
                    </div>
                )}
                <div className="mx_MessageComposer_row">
                    <div className="mx_SendMessageComposer" onClick={() => textarea.current?.focus()}>
                        <div className="mx_BasicMessageComposer">
                            <textarea
                                className="mx_BasicMessageComposer_input"
                                ref={textarea}
                                rows={1}
                                value={body}
                                onChange={(event) => {
                                    setBody(event.target.value);
                                    event.target.style.height = "auto";
                                    event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        void send();
                                    }
                                }}
                                placeholder={
                                    state.connection === "online"
                                        ? "Send a message…"
                                        : "Messages will send when reconnected"
                                }
                                aria-label="Message your agent"
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
                                if (event.target.files) void client.attachFiles([...event.target.files]);
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

function SignedInApp({ client, state }: { client: MatronJournalClient; state: ClientState }): React.ReactElement {
    const leftPanel = useLeftPanelResize();

    return (
        <div className="mx_MatrixChat_wrapper">
            <div className="mx_MatrixChat">
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
                        <div className="mx_RoomView">
                            <div className="mx_RoomView_body mx_MainSplit_timeline" data-layout="bubble">
                                <ChatHeader client={client} state={state} />
                                <Timeline client={client} state={state} />
                                <Composer client={client} state={state} />
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
