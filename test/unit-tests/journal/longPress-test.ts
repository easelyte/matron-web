/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { createLongPressController } from "../../../src/journal/longPress";

describe("long-press controller", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("fires after 500ms and records that the long press fired", () => {
        const onFire = jest.fn();
        const controller = createLongPressController({ delayMs: 500, onFire });

        controller.onPointerDown(10, 20);
        jest.advanceTimersByTime(499);
        expect(onFire).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        expect(onFire).toHaveBeenCalledTimes(1);
        expect(controller.didFire).toBe(true);
        expect(controller.isPending).toBe(false);
    });

    it.each([
        ["pointer up", (controller: ReturnType<typeof createLongPressController>) => controller.onPointerUp()],
        [
            "movement beyond the threshold",
            (controller: ReturnType<typeof createLongPressController>) => controller.onPointerMove(19, 20),
        ],
        [
            "pointer cancellation",
            (controller: ReturnType<typeof createLongPressController>) => controller.onPointerCancel(),
        ],
    ])("cancels on %s before the delay", (_label, cancel) => {
        const onFire = jest.fn();
        const controller = createLongPressController({ delayMs: 500, movementThreshold: 8, onFire });
        controller.onPointerDown(10, 20);

        cancel(controller);
        jest.advanceTimersByTime(500);

        expect(onFire).not.toHaveBeenCalled();
        expect(controller.didFire).toBe(false);
        expect(controller.isPending).toBe(false);
    });

    it("resets a fired gesture when pointer cancellation occurs", () => {
        const controller = createLongPressController({ delayMs: 500, onFire: jest.fn() });
        controller.onPointerDown(10, 20);
        jest.advanceTimersByTime(500);
        expect(controller.didFire).toBe(true);

        controller.onPointerCancel();

        expect(controller.didFire).toBe(false);
    });
});
