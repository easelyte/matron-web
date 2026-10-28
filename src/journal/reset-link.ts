/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The small, always-loaded half of password reset by email: reading a reset link from the address
 * (and removing its token from the address at once, so it is not left in the browser's history),
 * and asking the sign-in screen's server whether it sends mail. The forms are in PasswordReset.tsx.
 */

import { useEffect, useState } from "react";

import type { MatronJournalClient } from "./client";

/** How long the sign-in screen waits after the last keystroke in Server before asking it. */
export const FORGOT_CHECK_DEBOUNCE_MS = 400;

const RESET_PATH = /(?:^|\/)reset-password\/?$/;

// ── The reset link ───────────────────────────────────────────────────────────────────────────

let taken: { token: string } | null | undefined;

/**
 * The reset link this page was opened with, or null when it is not the reset page. The first
 * call reads the token and strips it from the address bar; later calls answer the same.
 */
export function takeResetLink(): { token: string } | null {
    if (taken !== undefined) return taken;
    if (!RESET_PATH.test(window.location.pathname)) {
        taken = null;
        return taken;
    }
    const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") ?? "";
    if (window.location.hash) {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    taken = { token };
    return taken;
}

/** Leave the reset page for the app's own address (…/app/reset-password → …/app/). */
export function leaveResetPage(): void {
    taken = null;
    const base = window.location.pathname.replace(RESET_PATH, "/");
    window.history.replaceState(window.history.state, "", base);
}

/** Tests only: forget what takeResetLink read. */
export function resetTakenLinkForTests(): void {
    taken = undefined;
}

/** Whether `server` mails reset links. Asked again (debounced) as the address changes; off until it answers. */
export function useForgotPasswordEnabled(client: MatronJournalClient, server: string): boolean {
    const [enabled, setEnabled] = useState<{ server: string; enabled: boolean }>();
    useEffect(() => {
        const target = server.trim();
        if (!target) return;
        let live = true;
        const timer = window.setTimeout(() => {
            client.forgotPasswordEnabled(target).then(
                (yes) => {
                    if (live) setEnabled({ server: target, enabled: yes });
                },
                () => {
                    if (live) setEnabled({ server: target, enabled: false });
                },
            );
        }, FORGOT_CHECK_DEBOUNCE_MS);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [client, server]);
    return enabled?.server === server.trim() && enabled.enabled;
}
