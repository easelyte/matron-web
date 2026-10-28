/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The sheets and panes that load in their own chunk (see lazy.tsx), each with the frame it shows
 * if it is opened before its chunk has arrived. Import them from here, never from their modules,
 * or the code lands back in the initial bundle.
 */

import React, { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";

import { CloseIcon } from "./icons";
import { deferred } from "./lazy";

type SettingsSheetProps = ComponentProps<typeof import("./SettingsSheet").SettingsSheet>;
type CoordinatorChooserProps = ComponentProps<typeof import("./CoordinatorSheets").CoordinatorChooserSheet>;
type RoutinesSheetProps = ComponentProps<typeof import("./CoordinatorSheets").RoutinesSheet>;
type ChatTasksPaneProps = ComponentProps<typeof import("./tracker/ChatTasksPane").ChatTasksPane>;
type TrackerPaneProps = ComponentProps<typeof import("./tracker/TrackerPane").TrackerPane>;
type TwoFactorSignInProps = ComponentProps<typeof import("./TwoFactor").TwoFactorSignIn>;
type ForgotPasswordFormProps = ComponentProps<typeof import("./PasswordReset").ForgotPasswordForm>;
type ResetPasswordPageProps = ComponentProps<typeof import("./PasswordReset").ResetPasswordPage>;

/** Same as the tasks pane's own: below this width it covers the chat. */
const CHAT_TASKS_OVERLAY_QUERY = "(max-width: 700px)";

const LOAD_FAILED = "Couldn't load this. Check your connection and try again.";

/**
 * While a frame covers the page: Escape closes it, as on the real sheet or pane, and Tab is held,
 * so focus stays on the opener rather than moving to the page behind. The frame takes no focus
 * itself: the real component remembers the element focused when it mounts, to return to on close,
 * and that must still be the opener.
 */
function useModalKeys(onClose: () => void, active = true): void {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        if (!active) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Tab") {
                event.preventDefault();
            } else if (event.key === "Escape") {
                event.preventDefault();
                onCloseRef.current();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [active]);
}

/** An empty modal sheet in the given classes. */
export function SheetFrame({
    scrimClassName,
    sheetClassName,
    label,
    failed,
    onClose,
}: {
    scrimClassName: string;
    sheetClassName: string;
    label: string;
    failed: boolean;
    onClose: () => void;
}): React.ReactElement {
    useModalKeys(onClose);
    return createPortal(
        <div
            className={scrimClassName}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className={sheetClassName} role="dialog" aria-modal="true" aria-label={label} aria-busy={!failed}>
                {failed ? (
                    <p className="mj_DeferredFailed" role="alert">
                        {LOAD_FAILED}
                    </p>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}

export const SettingsSheet = deferred<SettingsSheetProps>(
    () => import("./SettingsSheet").then((module) => module.SettingsSheet),
    (props, failed) => (
        <SheetFrame
            scrimClassName="mj_SettingsScrim"
            sheetClassName="mj_SettingsSheet"
            label="Settings"
            failed={failed}
            onClose={props.onClose}
        />
    ),
);

export const CoordinatorChooserSheet = deferred<CoordinatorChooserProps>(
    () => import("./CoordinatorSheets").then((module) => module.CoordinatorChooserSheet),
    (props, failed) => (
        <SheetFrame
            scrimClassName="mj_UploadConfirm_scrim"
            sheetClassName="mj_UploadConfirm mj_NewSessionSheet mj_PinSheet"
            label="Coordinator"
            failed={failed}
            onClose={props.onClose}
        />
    ),
);

export const RoutinesSheet = deferred<RoutinesSheetProps>(
    () => import("./CoordinatorSheets").then((module) => module.RoutinesSheet),
    (props, failed) => (
        <SheetFrame
            scrimClassName="mj_UploadConfirm_scrim"
            sheetClassName="mj_UploadConfirm mj_NewSessionSheet mj_RoutinesSheet"
            label="Routines"
            failed={failed}
            onClose={props.onClose}
        />
    ),
);

export const ChatTasksPane = deferred<ChatTasksPaneProps>(
    () => import("./tracker/ChatTasksPane").then((module) => module.ChatTasksPane),
    (props, failed) => <ChatTasksFrame close={() => props.client.toggleChatTasks(false)} failed={failed} />,
);

/**
 * The tasks pane's header, with its close button: on a narrow window the pane covers the whole
 * chat, including the button that opened it, so the frame must be closable on its own.
 */
export function ChatTasksFrame({ close, failed }: { close: () => void; failed: boolean }): React.ReactElement {
    // Beside the chat the pane is not modal; covering it (a narrow window) it is.
    const [overlay] = useState(() => window.matchMedia?.(CHAT_TASKS_OVERLAY_QUERY).matches ?? false);
    useModalKeys(close, overlay);
    return (
        <aside className="mj_ChatTasks" aria-label="Tasks and decisions" aria-busy={!failed}>
            <header className="mj_ChatTasks_header">
                <h1 className="mj_ChatTasks_title">Tasks &amp; decisions</h1>
                <button
                    type="button"
                    className="mj_IconButton mj_ChatTasks_close"
                    aria-label="Close tasks and decisions"
                    title="Close"
                    onClick={close}
                >
                    <CloseIcon aria-hidden />
                </button>
            </header>
            {failed ? (
                <p className="mj_DeferredFailed" role="alert">
                    {LOAD_FAILED}
                </p>
            ) : null}
        </aside>
    );
}

export const TrackerPane = deferred<TrackerPaneProps>(
    () => import("./tracker/TrackerPane").then((module) => module.TrackerPane),
    (props, failed) => <TrackerFrame close={() => props.client.closeTrackerView()} failed={failed} />,
);

/** The tracker's top bar, with its close button. */
export function TrackerFrame({ close, failed }: { close: () => void; failed: boolean }): React.ReactElement {
    return (
        <div className="mj_TrackerPane" aria-busy={!failed}>
            <div className="mj_TrackerPane_top">
                <button
                    type="button"
                    className="mj_IconButton mj_TrackerPane_close"
                    aria-label="Close tracker"
                    onClick={close}
                >
                    <CloseIcon />
                </button>
                <h1 className="mj_TrackerPane_title">Tracker</h1>
            </div>
            {failed ? (
                <div className="mj_TrackerEmpty" role="alert">
                    <p className="mj_TrackerEmpty_title">{LOAD_FAILED}</p>
                </div>
            ) : null}
        </div>
    );
}

/**
 * The sign-in screen's code step. Only two-factor accounts reach it, so it stays out of the first
 * download; the screen starts fetching it when the password is submitted.
 */
export const TwoFactorSignIn = deferred<TwoFactorSignInProps>(
    () => import("./TwoFactor").then((module) => module.TwoFactorSignIn),
    (props, failed) => (
        <div className="mj_LoginForm mj_TwoFactorStep" aria-busy={!failed}>
            {failed ? (
                <div className="mj_Error mj_Login_error" role="alert">
                    {LOAD_FAILED}
                </div>
            ) : (
                <p className="mj_TwoFactorStep_text" role="status">
                    Loading…
                </p>
            )}
            <button className="mj_TwoFactorStep_back" type="button" onClick={() => props.onBack()}>
                Back
            </button>
        </div>
    ),
);

/**
 * The sign-in screen's Forgot password? step. The screen starts fetching it once the server says
 * it sends mail, so it is usually here before the link is pressed.
 */
export const ForgotPasswordForm = deferred<ForgotPasswordFormProps>(
    () => import("./PasswordReset").then((module) => module.ForgotPasswordForm),
    (props, failed) => (
        <div className="mj_LoginForm mj_TwoFactorStep" aria-busy={!failed}>
            {failed ? (
                <div className="mj_Error mj_Login_error" role="alert">
                    {LOAD_FAILED}
                </div>
            ) : (
                <p className="mj_TwoFactorStep_text" role="status">
                    Loading…
                </p>
            )}
            <button className="mj_TwoFactorStep_back" type="button" onClick={() => props.onBack()}>
                Back to sign in
            </button>
        </div>
    ),
);

/** /app/reset-password: only a reset link opens it. */
export const ResetPasswordPage = deferred<ResetPasswordPageProps>(
    () => import("./PasswordReset").then((module) => module.ResetPasswordPage),
    (props, failed) => (
        <div className="mj_Login" aria-busy={!failed}>
            <main className="mj_Login_column">
                <img className="mj_Login_logo" src={props.logo} alt={props.brand} />
                {failed ? (
                    <div className="mj_Error mj_Login_error" role="alert">
                        {LOAD_FAILED}
                    </div>
                ) : (
                    <p className="mj_TwoFactorStep_text" role="status">
                        Loading…
                    </p>
                )}
            </main>
        </div>
    ),
);
