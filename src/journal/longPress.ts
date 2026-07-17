/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

export interface LongPressTimers {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface LongPressController {
    onPointerDown(clientX: number, clientY: number): void;
    onPointerMove(clientX: number, clientY: number): void;
    onPointerUp(): void;
    onPointerCancel(): void;
    readonly didFire: boolean;
    readonly isPending: boolean;
}

export function createLongPressController({
    delayMs,
    movementThreshold = 8,
    onFire,
    timers = {
        setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
}: {
    delayMs: number;
    movementThreshold?: number;
    onFire: () => void;
    timers?: LongPressTimers;
}): LongPressController {
    let timer: unknown;
    let start: { x: number; y: number } | undefined;
    let fired = false;

    const clearPending = (): void => {
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = undefined;
        start = undefined;
    };

    return {
        onPointerDown(clientX, clientY) {
            clearPending();
            fired = false;
            start = { x: clientX, y: clientY };
            timer = timers.setTimeout(() => {
                timer = undefined;
                start = undefined;
                fired = true;
                onFire();
            }, delayMs);
        },
        onPointerMove(clientX, clientY) {
            if (!start) return;
            if (Math.hypot(clientX - start.x, clientY - start.y) <= movementThreshold) return;
            clearPending();
            fired = false;
        },
        onPointerUp() {
            clearPending();
            if (!fired) fired = false;
        },
        onPointerCancel() {
            clearPending();
            fired = false;
        },
        get didFire() {
            return fired;
        },
        get isPending() {
            return timer !== undefined;
        },
    };
}
