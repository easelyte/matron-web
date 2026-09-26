/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * One-tap New session (redesign v6 surface C): the split button in the sidebar and the options
 * sheet behind its ⋯. The main segment starts a session at once with the defaults — the
 * operator's remembered choice for this box, else the box's own — and the sheet offers folder,
 * agent, model, browser tools, a first task and "Remember as my defaults".
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type MatronJournalClient, type StartOutcome } from "./client";
import {
    type AgentKind,
    defaultsHint,
    forgetRememberedDefaults,
    oneTapStart,
    pickBox,
    readRememberedDefaults,
    type RememberedDefaults,
    type SessionOptions,
    writeRememberedBox,
    writeRememberedDefaults,
} from "./new-session";
import { type DeviceDTO } from "./types";
import { V6Icon } from "./v6-icons";

function boxName(box: DeviceDTO): string {
    return box.name?.trim() || `Agent ${box.device_id}`;
}

/** Resolves once the client knows the conversation (its row can lag the start reply). */
function waitForConversation(client: MatronJournalClient, convoId: string, timeoutMs = 20_000): Promise<void> {
    const known = (): boolean => client.getSnapshot().conversations.some((conversation) => conversation.id === convoId);
    if (known()) return Promise.resolve();
    return new Promise((resolve) => {
        const done = (): void => {
            unsubscribe();
            window.clearTimeout(timer);
            resolve();
        };
        const unsubscribe = client.subscribe(() => {
            if (known()) done();
        });
        const timer = window.setTimeout(done, timeoutMs);
    });
}

/**
 * After a start: open the conversation and send the first task as an ordinary message
 * (CONTRACTS 5) once the conversation exists on the journal, so the send isn't refused.
 */
async function openStarted(client: MatronJournalClient, convoId: string, task: string): Promise<void> {
    try {
        await client.selectConversation(convoId, { fromRpcCreate: true });
        if (!task.trim()) return;
        await waitForConversation(client, convoId);
        await client.sendMessage(task, convoId);
    } catch (error) {
        console.warn("matron: opening the new session failed", error);
    }
}

type SplitState = { kind: "idle" } | { kind: "starting" } | { kind: "error"; message: string } | { kind: "uncertain" };

/**
 * The New session split button: one tap starts with the defaults; ⋯ opens the options sheet.
 * `boxes` is the agent roster (undefined while loading); none connected → disabled.
 */
export function NewSessionSplit({
    client,
    boxes,
    onOpenSheet,
    onStartedFocus,
    moreRef,
    onCheckList,
}: {
    client: MatronJournalClient;
    boxes: DeviceDTO[] | undefined;
    onOpenSheet: () => void;
    onStartedFocus?: () => void;
    moreRef: React.RefObject<HTMLButtonElement | null>;
    onCheckList: () => void;
}): React.ReactElement {
    const [state, setState] = useState<SplitState>({ kind: "idle" });
    const mainRef = useRef<HTMLButtonElement>(null);
    // One key per start intent, reused by Retry, so an uncertain start can't spawn twice.
    const intentRef = useRef<string | undefined>(undefined);
    const box = boxes ? pickBox(boxes) : undefined;
    const nobox = boxes !== undefined && !box;
    const [remembered, setRemembered] = useState<RememberedDefaults | undefined>(() =>
        box ? readRememberedDefaults(box.device_id) : undefined,
    );
    useEffect(() => {
        setRemembered(box ? readRememberedDefaults(box.device_id) : undefined);
        const onStorage = (): void => setRemembered(box ? readRememberedDefaults(box.device_id) : undefined);
        window.addEventListener("storage", onStorage);
        window.addEventListener("matron:new-session-defaults", onStorage);
        return () => {
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("matron:new-session-defaults", onStorage);
        };
    }, [box]);
    const hint = box ? defaultsHint(remembered, undefined) : undefined;

    const startingRef = useRef(false);
    const start = async (retry = false): Promise<void> => {
        if (startingRef.current) return;
        startingRef.current = true;
        setState({ kind: "starting" });
        mainRef.current?.focus();
        if (!retry || !intentRef.current) intentRef.current = crypto.randomUUID();
        // A fresh roster per tap: the box may have come up (or gone) since the sidebar loaded.
        let target: DeviceDTO | undefined;
        try {
            target = pickBox(await client.listAgents());
        } catch {
            target = box;
        }
        if (!target) {
            startingRef.current = false;
            setState({ kind: "error", message: "Couldn’t reach the box." });
            return;
        }
        const params = oneTapStart(readRememberedDefaults(target.device_id));
        const outcome: StartOutcome = await client.startSessionRpc(target.device_id, params.workdir, false, {
            model: params.model,
            agent: params.agent,
            idempotencyKey: intentRef.current,
        });
        startingRef.current = false;
        if (outcome.kind === "created") {
            intentRef.current = undefined;
            setState({ kind: "idle" });
            onStartedFocus?.();
            void openStarted(client, outcome.convoId, "");
        } else if (outcome.kind === "uncertain") {
            setState({ kind: "uncertain" });
        } else if (outcome.code === "bad_workdir" || outcome.code === "bad_model" || outcome.code === "bad_agent") {
            // The saved defaults no longer work on this box: forget them, so the next tap uses
            // the box's own defaults, and point at Options.
            forgetRememberedDefaults(target.device_id);
            setRemembered(undefined);
            intentRef.current = undefined;
            setState({ kind: "error", message: "Your saved defaults don’t work on this box any more." });
        } else {
            setState({ kind: "error", message: outcome.reach ? "Couldn’t reach the box." : outcome.message });
        }
    };

    const starting = state.kind === "starting";
    const disabled = starting || nobox;
    const mainLabel = starting
        ? "Starting a new session"
        : hint
          ? `Start a new session: ${hint}`
          : "Start a new session";
    return (
        <div className="mj_NewSessionRow">
            <div
                className={`mj_NewSessionSplit${nobox ? " mj_NewSessionSplit_disabled" : ""}`}
                role="group"
                aria-label="New session"
            >
                <button
                    ref={mainRef}
                    type="button"
                    className="mj_NewSessionButton mj_NewSessionSplit_main"
                    aria-label={mainLabel}
                    disabled={disabled}
                    onClick={() => void start()}
                >
                    {starting ? (
                        <>
                            <span className="mj_Spinner" aria-hidden="true" />
                            <span className="mj_NewSessionSplit_label">Starting…</span>
                        </>
                    ) : (
                        <>
                            <V6Icon name="pencil" />
                            <span className="mj_NewSessionSplit_label">New session</span>
                            {hint && !nobox && <span className="mj_NewSessionSplit_hint">{hint}</span>}
                        </>
                    )}
                </button>
                <span className="mj_NewSessionSplit_sep" aria-hidden="true" />
                <button
                    ref={moreRef}
                    type="button"
                    className="mj_NewSessionSplit_more"
                    aria-label="New session options"
                    aria-haspopup="dialog"
                    // Stays enabled with no box: the sheet re-checks and says so itself.
                    disabled={starting}
                    onClick={() => {
                        if (state.kind === "error") setState({ kind: "idle" });
                        onOpenSheet();
                    }}
                >
                    <V6Icon name="dots" />
                </button>
            </div>
            {state.kind === "error" && (
                <div className="mj_NewSessionSplit_note mj_NewSessionSplit_note_error" role="alert">
                    {state.message}{" "}
                    <button type="button" onClick={() => void start(true)}>
                        Retry
                    </button>{" "}
                    ·{" "}
                    <button
                        type="button"
                        onClick={() => {
                            setState({ kind: "idle" });
                            onOpenSheet();
                        }}
                    >
                        Options
                    </button>
                </div>
            )}
            {state.kind === "uncertain" && (
                <div className="mj_NewSessionSplit_note" role="status">
                    May have started.{" "}
                    <button
                        type="button"
                        onClick={() => {
                            setState({ kind: "idle" });
                            onCheckList();
                        }}
                    >
                        Check your list
                    </button>
                </div>
            )}
            {nobox && <div className="mj_NewSessionSplit_note">No box connected</div>}
        </div>
    );
}

type SheetState =
    | { step: "loading" }
    | { step: "nobox" }
    | { step: "load-error" }
    | { step: "form"; box: DeviceDTO; options: SessionOptions }
    | { step: "uncertain" };

/** The New session options sheet (`.mj_NewSessionSheet` on the upload-confirm shell). */
export function NewSessionSheet({
    client,
    onClose: close,
}: {
    client: MatronJournalClient;
    /** `started` = closed because a session started (focus then stays with the new chat). */
    onClose: (started?: boolean) => void;
}): React.ReactElement {
    const [sheet, setSheet] = useState<SheetState>({ step: "loading" });
    const [boxes, setBoxes] = useState<DeviceDTO[]>([]);
    const [folder, setFolder] = useState<string | "other" | "">("");
    const [other, setOther] = useState("");
    const [folderError, setFolderError] = useState<string>();
    const [error, setError] = useState<string>();
    const [agent, setAgent] = useState<AgentKind>("claude");
    const [model, setModel] = useState("");
    const [browser, setBrowser] = useState(false);
    const [task, setTask] = useState("");
    const [remember, setRemember] = useState(false);
    const [starting, setStarting] = useState(false);
    const mountedRef = useRef(true);
    const requestRef = useRef(0);
    const dialogRef = useRef<HTMLDivElement>(null);
    const otherRef = useRef<HTMLInputElement>(null);
    const ids = useId();
    const intentRef = useRef(crypto.randomUUID());
    // No closing mid-start: the typed first task would be lost with the sheet.
    const onClose = (): void => {
        if (!starting) close(false);
    };

    const loadBox = useCallback(
        (box: DeviceDTO): void => {
            const request = ++requestRef.current;
            setSheet({ step: "loading" });
            client.sessionOptions(box.device_id).then(
                (options) => {
                    if (!mountedRef.current || request !== requestRef.current) return;
                    const remembered = readRememberedDefaults(box.device_id);
                    const preferredFolder = remembered?.folder ?? options.defaultFolder;
                    setFolder(
                        preferredFolder && options.folders.some((entry) => entry.path === preferredFolder)
                            ? preferredFolder
                            : (options.folders[0]?.path ?? ""),
                    );
                    const preferredAgent = remembered?.agent ?? options.defaultAgent ?? "claude";
                    setAgent(options.agents.includes(preferredAgent) ? preferredAgent : options.agents[0]);
                    const rememberedModel =
                        remembered?.model && options.models.some((option) => option.value === remembered.model)
                            ? remembered.model
                            : undefined;
                    setModel(rememberedModel ?? options.defaultModel ?? "");
                    setSheet({ step: "form", box, options });
                },
                () => {
                    if (mountedRef.current && request === requestRef.current) setSheet({ step: "load-error" });
                },
            );
        },
        [client],
    );

    const load = useCallback((): void => {
        setSheet({ step: "loading" });
        client.listAgents().then(
            (agents) => {
                if (!mountedRef.current) return;
                const connected = agents.filter((candidate) => candidate.connected);
                setBoxes(connected);
                if (!connected.length) setSheet({ step: "nobox" });
                else loadBox(connected[0]);
            },
            () => {
                if (mountedRef.current) setSheet({ step: "load-error" });
            },
        );
    }, [client, loadBox]);

    useEffect(() => {
        mountedRef.current = true;
        load();
        return () => {
            mountedRef.current = false;
        };
    }, [load]);

    // Focus lands on the selected folder once the form is up (§5).
    const formReady = sheet.step === "form";
    useLayoutEffect(() => {
        if (!formReady) return;
        const selected = dialogRef.current?.querySelector<HTMLElement>('.mj_FolderOption[aria-checked="true"]');
        (selected ?? dialogRef.current?.querySelector<HTMLElement>(".mj_FolderOption"))?.focus();
    }, [formReady]);

    const form = sheet.step === "form" ? sheet : undefined;
    const codex = agent === "codex";
    const defaultTagFolder = useMemo(() => {
        if (!form) return undefined;
        return readRememberedDefaults(form.box.device_id)?.folder ?? form.options.defaultFolder;
    }, [form]);

    const submit = async (): Promise<void> => {
        if (!form || starting) return;
        const workdir = folder === "other" ? other.trim() : folder;
        if (folder === "other" && !workdir) {
            setFolderError("That folder doesn’t exist on the box.");
            otherRef.current?.focus();
            return;
        }
        setStarting(true);
        setError(undefined);
        setFolderError(undefined);
        const showAgents = form.options.agents.length > 1;
        const outcome = await client.startSessionRpc(form.box.device_id, workdir, !codex && browser, {
            model: codex || !model ? undefined : model,
            agent: showAgents ? agent : undefined,
            idempotencyKey: intentRef.current,
        });
        if (outcome.kind === "created") {
            // Runs even if the sheet is already gone: the session exists, the task must follow it.
            if (remember) {
                writeRememberedDefaults(form.box.device_id, {
                    folder: workdir || undefined,
                    model: codex ? undefined : model || undefined,
                    agent: showAgents ? agent : undefined,
                });
                writeRememberedBox(form.box.device_id);
                window.dispatchEvent(new Event("matron:new-session-defaults"));
            }
            void openStarted(client, outcome.convoId, task);
            if (mountedRef.current) close(true);
            return;
        }
        if (!mountedRef.current) return;
        setStarting(false);
        if (outcome.kind === "uncertain") {
            setSheet({ step: "uncertain" });
            return;
        }
        if (outcome.code === "bad_workdir") {
            setFolderError("That folder doesn’t exist on the box.");
            if (folder !== "other") {
                setFolder("other");
                setOther(workdir);
            }
            requestAnimationFrame(() => otherRef.current?.focus());
            return;
        }
        setError(outcome.message);
    };

    const onFolderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".mj_FolderOption")];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length];
        event.preventDefault();
        next?.focus();
        next?.click();
    };

    const errorId = `${ids}-folder-error`;
    return (
        <div
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
                className="mj_UploadConfirm mj_UploadConfirm_queue mj_NewSessionSheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${ids}-title`}
            >
                <header className="mj_UploadConfirm_header">
                    <V6Icon name="plus" className="mj_UploadConfirm_uploadIcon" />
                    <h2 className="mj_UploadConfirm_title" id={`${ids}-title`}>
                        New session
                    </h2>
                    <span className="mj_UploadConfirm_headerSpacer" />
                    <button
                        type="button"
                        className="mj_UploadConfirm_close"
                        aria-label="Close"
                        disabled={starting}
                        onClick={onClose}
                    >
                        <V6Icon name="x" />
                    </button>
                </header>
                <div className="mj_UploadConfirm_body">
                    {sheet.step === "loading" && (
                        <p role="status">
                            <span className="mj_Spinner" aria-hidden="true" /> Loading…
                        </p>
                    )}
                    {sheet.step === "nobox" && <p>No box connected</p>}
                    {sheet.step === "load-error" && (
                        <p className="mj_FieldError" role="alert">
                            Couldn’t reach the box.{" "}
                            <button type="button" className="mj_TextButton" onClick={load}>
                                Retry
                            </button>
                        </p>
                    )}
                    {sheet.step === "uncertain" && (
                        <p role="status">May have started. Check your list before trying again.</p>
                    )}
                    {form && (
                        <>
                            <div className="mj_Field">
                                <span className="mj_FieldLabel" id={`${ids}-folder`}>
                                    Folder
                                </span>
                                <div
                                    className="mj_FolderList"
                                    role="radiogroup"
                                    aria-labelledby={`${ids}-folder`}
                                    onKeyDown={onFolderKeyDown}
                                >
                                    {form.options.folders.map((entry) => (
                                        <button
                                            key={entry.path}
                                            type="button"
                                            className="mj_FolderOption"
                                            role="radio"
                                            aria-checked={folder === entry.path}
                                            tabIndex={folder === entry.path ? 0 : -1}
                                            title={entry.path}
                                            onClick={() => {
                                                setFolder(entry.path);
                                                setFolderError(undefined);
                                            }}
                                        >
                                            <span className="mj_Radio" aria-hidden="true" />
                                            <span className="mj_FolderOption_path">{entry.path}</span>
                                            {entry.path === defaultTagFolder ? (
                                                <span className="mj_Tag">default</span>
                                            ) : (
                                                <span />
                                            )}
                                        </button>
                                    ))}
                                    <button
                                        type="button"
                                        className="mj_FolderOption"
                                        role="radio"
                                        aria-checked={folder === "other"}
                                        tabIndex={folder === "other" || !folder ? 0 : -1}
                                        onClick={() => {
                                            setFolder("other");
                                            requestAnimationFrame(() => otherRef.current?.focus());
                                        }}
                                    >
                                        <span className="mj_Radio" aria-hidden="true" />
                                        <span className="mj_FolderOption_path">Other folder…</span>
                                        <span />
                                    </button>
                                </div>
                                {folder === "other" && (
                                    <input
                                        ref={otherRef}
                                        className={`mj_TextInput${folderError ? " mj_TextInput_error" : ""}`}
                                        type="text"
                                        aria-label="Other folder"
                                        placeholder="/path/on/the/box"
                                        value={other}
                                        aria-invalid={Boolean(folderError)}
                                        aria-describedby={folderError ? errorId : undefined}
                                        onChange={(event) => {
                                            setOther(event.target.value);
                                            setFolderError(undefined);
                                        }}
                                    />
                                )}
                                {folderError && (
                                    <span className="mj_FieldError" id={errorId} role="alert">
                                        {folderError}
                                    </span>
                                )}
                            </div>
                            {form.options.agents.length > 1 && (
                                <div className="mj_Field">
                                    <span className="mj_FieldLabel" id={`${ids}-agent`}>
                                        Agent
                                    </span>
                                    <div className="mj_Segmented" role="radiogroup" aria-labelledby={`${ids}-agent`}>
                                        {(["claude", "codex"] as const)
                                            .filter((kind) => form.options.agents.includes(kind))
                                            .map((kind) => (
                                                <button
                                                    key={kind}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={agent === kind}
                                                    onClick={() => setAgent(kind)}
                                                >
                                                    {kind === "claude" ? "Claude" : "Codex"}
                                                </button>
                                            ))}
                                    </div>
                                </div>
                            )}
                            {(form.options.models.length > 0 || codex) && (
                                <div className="mj_Field">
                                    <label className="mj_FieldLabel" htmlFor={`${ids}-model`}>
                                        Model
                                    </label>
                                    <select
                                        id={`${ids}-model`}
                                        className="mj_Select"
                                        value={codex ? "" : model}
                                        disabled={codex}
                                        onChange={(event) => setModel(event.target.value)}
                                    >
                                        {!form.options.defaultModel && <option value="">Box default</option>}
                                        {form.options.models.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                                {option.value === form.options.defaultModel ? " (box default)" : ""}
                                            </option>
                                        ))}
                                    </select>
                                    {codex && <span className="mj_FieldHint">Codex picks its own model</span>}
                                </div>
                            )}
                            <div className="mj_Field mj_SwitchRow">
                                <span className="mj_SwitchLabel" id={`${ids}-browser`}>
                                    Browser tools
                                </span>
                                <button
                                    type="button"
                                    className="mj_SwitchButton"
                                    role="switch"
                                    aria-checked={!codex && browser}
                                    aria-labelledby={`${ids}-browser`}
                                    disabled={codex}
                                    onClick={() => setBrowser((current) => !current)}
                                >
                                    <span
                                        className={`mj_Switch${!codex && browser ? " is-on" : ""}${codex ? " is-disabled" : ""}`}
                                    />
                                </button>
                                {codex && <span className="mj_FieldHint">Not available for Codex sessions</span>}
                            </div>
                            <div className="mj_Field">
                                <label className="mj_FieldLabel" htmlFor={`${ids}-task`}>
                                    First task (optional)
                                </label>
                                <textarea
                                    id={`${ids}-task`}
                                    className="mj_TextArea"
                                    placeholder="What should it start on?"
                                    value={task}
                                    onChange={(event) => setTask(event.target.value)}
                                />
                            </div>
                            <label className="mj_CheckRow">
                                <input
                                    type="checkbox"
                                    checked={remember}
                                    onChange={(event) => setRemember(event.target.checked)}
                                />
                                Remember as my defaults
                            </label>
                            {boxes.length > 1 ? (
                                <div className="mj_Field">
                                    <label className="mj_FieldLabel" htmlFor={`${ids}-box`}>
                                        Box
                                    </label>
                                    <select
                                        id={`${ids}-box`}
                                        className="mj_Select"
                                        value={form.box.device_id}
                                        onChange={(event) => {
                                            const next = boxes.find(
                                                (candidate) => candidate.device_id === Number(event.target.value),
                                            );
                                            if (next) loadBox(next);
                                        }}
                                    >
                                        {boxes.map((candidate) => (
                                            <option key={candidate.device_id} value={candidate.device_id}>
                                                {boxName(candidate)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            ) : (
                                <span className="mj_BoxCaption">On {boxName(form.box)}</span>
                            )}
                            {error && (
                                <p className="mj_FieldError" role="alert">
                                    {error}
                                </p>
                            )}
                        </>
                    )}
                </div>
                <footer className="mj_UploadConfirm_footer">
                    <div className="mj_UploadConfirm_actions">
                        <button type="button" disabled={starting} onClick={onClose}>
                            {sheet.step === "uncertain" ? "Close" : "Cancel"}
                        </button>
                        {form && (
                            <button
                                type="button"
                                className="mj_UploadConfirm_send"
                                disabled={starting}
                                onClick={() => void submit()}
                            >
                                {starting ? "Starting…" : "Start session"}
                            </button>
                        )}
                    </div>
                </footer>
            </div>
        </div>
    );
}
