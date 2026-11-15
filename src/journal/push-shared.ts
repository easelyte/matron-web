/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

export function notificationTag(convoId: string): string {
    return `matron:${convoId}`;
}

export function parseConvoHash(hash: string): string | null {
    if (!hash.startsWith("#convo=") || hash.length > 7 + 128 * 12) return null;
    try {
        const id = decodeURIComponent(hash.slice(7));
        return id.length > 0 && id.length <= 128 ? id : null;
    } catch {
        return null;
    }
}
