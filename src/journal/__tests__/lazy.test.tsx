/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ChatTasksFrame, SheetFrame, TrackerFrame } from "../deferred-ui";
import { deferred, preloadDeferredUi } from "../lazy";

function Greeting({ name }: { name: string }): React.ReactElement {
    return <p data-testid="greeting">Hello {name}</p>;
}

function fallback(_props: { name: string }, failed: boolean): ReactNode {
    return <p data-testid="fallback">{failed ? "failed" : "loading"}</p>;
}

/** A promise the test settles by hand. */
function manual<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class Catcher extends Component<{ children: ReactNode }, { error?: Error }> {
    public state: { error?: Error } = {};
    public static getDerivedStateFromError(error: Error): { error: Error } {
        return { error };
    }
    public render(): ReactNode {
        return this.state.error ? <p data-testid="caught">{this.state.error.message}</p> : this.props.children;
    }
}

describe("deferred components", () => {
    let container: HTMLDivElement;
    let root: Root;
    const text = (testId: string): string | null =>
        document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.useRealTimers();
    });

    it("shows the fallback while the chunk loads, then the component", async () => {
        const chunk = manual<typeof Greeting>();
        const Lazy = deferred(() => chunk.promise, fallback);
        await act(async () => root.render(<Lazy name="alice" />));
        expect(text("fallback")).toBe("loading");
        expect(text("greeting")).toBeNull();

        await act(async () => chunk.resolve(Greeting));
        expect(text("fallback")).toBeNull();
        expect(text("greeting")).toBe("Hello alice");
    });

    it("mounts in the same render, without the fallback, once preloaded", async () => {
        const load = jest.fn(async () => Greeting);
        const frame = jest.fn(fallback);
        const Lazy = deferred(load, frame);
        await Lazy.preload();
        await Lazy.preload();
        expect(load).toHaveBeenCalledTimes(1);

        act(() => root.render(<Lazy name="bob" />));
        expect(text("greeting")).toBe("Hello bob");
        expect(document.querySelector('[data-testid="fallback"]')).toBeNull();
    });

    it("shows the failed frame when the chunk cannot be fetched, and fetches again on the next open", async () => {
        const load = jest
            .fn<Promise<typeof Greeting>, []>()
            .mockRejectedValueOnce(new Error("ChunkLoadError"))
            .mockResolvedValue(Greeting);
        const Lazy = deferred(load, fallback);
        const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await act(async () => root.render(<Lazy name="carol" />));
            expect(text("fallback")).toBe("failed");

            // Closing and opening again mounts afresh and retries the fetch.
            await act(async () => root.render(<></>));
            await act(async () => root.render(<Lazy name="carol" />));
            expect(load).toHaveBeenCalledTimes(2);
            expect(text("greeting")).toBe("Hello carol");
        } finally {
            spy.mockRestore();
        }
    });

    it("lets a render error in the loaded component through to the boundaries above", async () => {
        function Broken(): React.ReactElement {
            throw new Error("boom");
        }
        const Lazy = deferred(
            async () => Broken,
            () => <p data-testid="fallback" />,
        );
        const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await act(async () =>
                root.render(
                    <Catcher>
                        <Lazy />
                    </Catcher>,
                ),
            );
            expect(text("caught")).toBe("boom");
            expect(document.querySelector('[data-testid="fallback"]')).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });

    it("preloads every deferred chunk once the browser is idle, and not after cleanup", () => {
        jest.useFakeTimers();
        const first = jest.fn(async () => Greeting);
        const second = jest.fn(async () => Greeting);
        deferred(first, fallback);
        deferred(second, fallback);

        const cancel = preloadDeferredUi();
        expect(first).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        cancel();

        const third = jest.fn(async () => Greeting);
        deferred(third, fallback);
        preloadDeferredUi()();
        jest.advanceTimersByTime(1000);
        expect(third).not.toHaveBeenCalled();
    });

    it("uses requestIdleCallback where the browser has it", () => {
        const idle = jest.fn((_run: IdleRequestCallback, _options?: IdleRequestOptions) => 7);
        const cancelIdle = jest.fn();
        const win = window as unknown as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };
        win.requestIdleCallback = idle;
        win.cancelIdleCallback = cancelIdle;
        try {
            const load = jest.fn(async () => Greeting);
            deferred(load, fallback);
            const cancel = preloadDeferredUi();
            expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
            expect(load).not.toHaveBeenCalled();
            idle.mock.calls[0][0]({ didTimeout: false, timeRemaining: () => 50 });
            expect(load).toHaveBeenCalledTimes(1);
            cancel();
            expect(cancelIdle).toHaveBeenCalledWith(7);
        } finally {
            delete win.requestIdleCallback;
            delete win.cancelIdleCallback;
        }
    });

    it("hands focus back to the opener when the sheet arrives after its frame", async () => {
        // The real sheets remember the element focused when they mount and refocus it on close.
        function Sheet({ onClose }: { onClose: () => void }): React.ReactElement {
            React.useEffect(() => {
                const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                document.querySelector<HTMLElement>("[data-testid=sheet-close]")?.focus();
                return () => opener?.focus();
            }, []);
            return (
                <button type="button" data-testid="sheet-close" onClick={onClose}>
                    Close
                </button>
            );
        }
        const chunk = manual<typeof Sheet>();
        const Lazy = deferred(
            () => chunk.promise,
            (props: { onClose: () => void }, failed) => (
                <SheetFrame
                    scrimClassName="scrim"
                    sheetClassName="sheet"
                    label="Sheet"
                    failed={failed}
                    onClose={props.onClose}
                />
            ),
        );
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();
        try {
            await act(async () => root.render(<Lazy onClose={() => undefined} />));
            expect(document.querySelector(".sheet")).not.toBeNull();
            expect(document.activeElement).toBe(opener);

            await act(async () => chunk.resolve(Sheet));
            expect(document.querySelector(".sheet")).toBeNull();
            expect(document.activeElement).toBe(document.querySelector("[data-testid=sheet-close]"));

            await act(async () => root.render(<></>));
            expect(document.activeElement).toBe(opener);
        } finally {
            opener.remove();
        }
    });
});

describe("SheetFrame", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it("leaves focus on the opener, closes on Escape and on the scrim, and says when loading failed", () => {
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();
        const onClose = jest.fn();
        const frame = (failed: boolean): React.ReactElement => (
            <SheetFrame
                scrimClassName="mj_SettingsScrim"
                sheetClassName="mj_SettingsSheet"
                label="Settings"
                failed={failed}
                onClose={onClose}
            />
        );

        act(() => root.render(frame(false)));
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.getAttribute("aria-label")).toBe("Settings");
        expect(dialog.getAttribute("aria-busy")).toBe("true");
        expect(document.activeElement).toBe(opener);

        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(onClose).toHaveBeenCalledTimes(1);

        // Tab stays on the opener rather than moving to the page behind the scrim.
        const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        act(() => {
            document.dispatchEvent(tab);
        });
        expect(tab.defaultPrevented).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);

        act(() => dialog.click());
        expect(onClose).toHaveBeenCalledTimes(1);
        act(() => document.querySelector<HTMLElement>(".mj_SettingsScrim")!.click());
        expect(onClose).toHaveBeenCalledTimes(2);

        act(() => root.render(frame(true)));
        expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Couldn't load/);
        opener.remove();
    });
});

describe("pane frames", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it.each([
        ["tasks", "Close tasks and decisions", ChatTasksFrame],
        ["tracker", "Close tracker", TrackerFrame],
    ])("the %s frame can be closed on its own and says when loading failed", (_name, label, Frame) => {
        const close = jest.fn();
        act(() => root.render(<Frame close={close} failed={false} />));
        expect(container.querySelector('[role="alert"]')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
        expect(close).toHaveBeenCalledTimes(1);

        act(() => root.render(<Frame close={close} failed />));
        expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Couldn't load/);
    });
});

describe("tasks frame on a narrow window", () => {
    const realMatchMedia = window.matchMedia;
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        window.matchMedia = realMatchMedia;
    });

    const press = (key: string): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        act(() => {
            document.dispatchEvent(event);
        });
        return event;
    };

    it("covering the chat, closes on Escape and holds Tab", () => {
        window.matchMedia = ((query: string) => ({ matches: true, media: query })) as typeof window.matchMedia;
        const close = jest.fn();
        act(() => root.render(<ChatTasksFrame close={close} failed={false} />));
        expect(press("Tab").defaultPrevented).toBe(true);
        press("Escape");
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("beside the chat, leaves the keyboard alone", () => {
        window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
        const close = jest.fn();
        act(() => root.render(<ChatTasksFrame close={close} failed={false} />));
        expect(press("Tab").defaultPrevented).toBe(false);
        press("Escape");
        expect(close).not.toHaveBeenCalled();
    });
});
