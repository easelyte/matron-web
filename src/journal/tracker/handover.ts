/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useEffect, useState } from "react";

import type { TrackerHandover } from "../types";

/** Keep a pending offer current even while the detail stays open or the client is offline. */
export function useHandoverCaption(handover: TrackerHandover | null | undefined): string | null {
    const [tick, setTick] = useState(0);
    const expiresAt = handover?.expires_at;
    const expired = expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= Date.now();
    useEffect(() => {
        if (expiresAt == null || expired) return;
        // If expiry passed since render, schedule a refresh now instead of leaving the caption up.
        const wait = Math.max(0, Math.min(expiresAt - Date.now(), 2 ** 31 - 1));
        const timer = window.setTimeout(() => setTick((n) => n + 1), wait);
        return () => window.clearTimeout(timer);
    }, [expiresAt, expired, tick]);

    if (!handover || expired) return null;
    const target = handover.to_convo_title?.trim() || "Conversation";
    if (handover.state === "offered") return `Offered to ${target} · waiting for them to accept`;
    if (handover.state === "awaiting_user") return `Offered to ${target} · waiting for your OK`;
    return null;
}
