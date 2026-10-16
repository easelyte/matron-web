/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Code splitting for UI that first paint does not need: settings, the tracker, the Coordinator
 * sheets, the per-chat tasks pane. Each one is its own chunk, fetched after sign-in once the
 * browser is idle (preloadDeferredUi), so by the time someone opens it the code is already there
 * and it mounts in the same frame, exactly as before. Only a very early open, or a slow network,
 * shows the fallback: the frame of the sheet or pane, without content, until the chunk arrives.
 */

import React, { Component, Suspense, useState, type ComponentType, type ReactNode } from "react";

const registry: DeferredComponent<unknown>[] = [];

/** A chunk that could not be fetched. Other render errors are not caught here. */
class DeferredLoadError extends Error {}

export type DeferredComponent<P> = ((props: P) => React.ReactElement) & {
    /** Fetches the chunk now. Safe to call repeatedly; a failed fetch is retried on the next call. */
    preload: () => Promise<ComponentType<P>>;
};

/**
 * A component whose code loads on demand. `fallback` renders in its place while the chunk is in
 * flight, and again with `failed` set if it could not be fetched (offline), so a sheet still has
 * its frame and a way to close.
 */
export function deferred<P extends object>(
    load: () => Promise<ComponentType<P>>,
    fallback: (props: P, failed: boolean) => ReactNode,
): DeferredComponent<P> {
    let loaded: ComponentType<P> | undefined;
    let pending: Promise<ComponentType<P>> | undefined;
    const preload = (): Promise<ComponentType<P>> =>
        (pending ??= load().then(
            (component) => (loaded = component),
            (error: unknown) => {
                pending = undefined;
                throw new DeferredLoadError(String(error));
            },
        ));

    function Deferred(props: P): React.ReactElement {
        // Chosen once per mount: the real component when its chunk is already here (the usual
        // case, after the idle preload), else a lazy wrapper for this mount. Never swapped while
        // mounted, which would remount it and lose its state.
        const [Resolved] = useState<ComponentType<P>>(
            () => loaded ?? React.lazy(async () => ({ default: await preload() })),
        );
        return (
            <LoadBoundary fallback={fallback(props, true)}>
                <Suspense fallback={fallback(props, false)}>
                    <Resolved {...props} />
                </Suspense>
            </LoadBoundary>
        );
    }
    Deferred.preload = preload;
    registry.push(Deferred as DeferredComponent<unknown>);
    return Deferred;
}

/** Fetches every deferred chunk in the background once the browser is idle. */
export function preloadDeferredUi(): () => void {
    const run = (): void => {
        for (const component of registry) component.preload().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(run, { timeout: 3000 });
        return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 1000);
    return () => window.clearTimeout(handle);
}

class LoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { error?: unknown }> {
    public state: { error?: unknown } = {};

    public static getDerivedStateFromError(error: unknown): { error: unknown } {
        return { error };
    }

    public render(): ReactNode {
        const { error } = this.state;
        if (error === undefined) return this.props.children;
        // Anything but a failed fetch is a real bug: let it reach the boundaries above.
        if (!(error instanceof DeferredLoadError)) throw error;
        return this.props.fallback;
    }
}
