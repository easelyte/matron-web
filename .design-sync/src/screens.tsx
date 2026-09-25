// design-sync wrappers: the theme provider every preview card uses, and whole-screen renders of
// the REAL MatronApp driven by a fixture client. Copied by build-pkg.mjs to .ds-sync/pkg/src/ds/
// (imports resolve against ../journal/ in that layout). Nothing here ships in the app.
import React, { useMemo } from "react";

import { MatronApp } from "../journal/components";
import { createFixtureClient, type FixtureClientOptions, type FixtureScreen } from "./fixtures";

export type MatronTheme = "light" | "dark";

export interface MatronThemeProviderProps {
    /** "light" (default) or "dark". Themes are token blocks keyed on [data-theme], so a dark
     *  subtree can sit inside a light page. */
    theme?: MatronTheme;
    /** Inner padding in px around the content (default 16). */
    padding?: number;
    /** Canvas colour: "app" (the warm app background, default) or "default" (white / dark canvas). */
    surface?: "app" | "default";
    children?: React.ReactNode;
}

/**
 * Theme root for anything built with this design system. Sets `data-theme` (the app keys every
 * colour token on it), paints the app canvas, and applies the base type (Inter, 15px root).
 * Wrap a whole screen once; nest a second provider to show the other theme side by side.
 */
export function MatronThemeProvider({
    theme = "light",
    padding = 16,
    surface = "app",
    children,
}: MatronThemeProviderProps): React.ReactElement {
    return (
        <div
            data-theme={theme}
            className="mj_DsThemeRoot"
            style={{
                background:
                    surface === "app" ? "var(--cpd-color-bg-app)" : "var(--cpd-color-bg-canvas-default)",
                color: "var(--cpd-color-text-primary)",
                fontFamily:
                    'Inter, "Helvetica Neue", "Segoe UI", Roboto, Ubuntu, "Fira Sans", "Noto Sans", Arial, sans-serif',
                lineHeight: 1.5,
                padding,
                colorScheme: theme,
            }}
        >
            {children}
        </div>
    );
}

export interface MatronScreenProps {
    /** Which app surface to show (see FixtureScreen). Default "chat". */
    screen?: FixtureScreen;
    theme?: MatronTheme;
    /** Frame size in px. Defaults: 1180 x 720. */
    width?: number | string;
    height?: number;
    /** Extra fixture overrides (state patch, read-only files). */
    fixture?: Omit<FixtureClientOptions, "screen">;
}

function ScreenFrame({
    theme,
    width,
    height,
    children,
}: {
    theme: MatronTheme;
    width: number | string;
    height: number;
    children: React.ReactNode;
}): React.ReactElement {
    // translateZ(0) makes the frame the containing block for the app's position:fixed layers
    // (mobile nav, modals, toasts), so they land inside the frame instead of the page viewport.
    return (
        <div
            data-theme={theme}
            className="mj_DsScreen"
            style={{
                width,
                maxWidth: "100%",
                height,
                position: "relative",
                overflow: "hidden",
                transform: "translateZ(0)",
                background: "var(--cpd-color-bg-canvas-default)",
                color: "var(--cpd-color-text-primary)",
                fontFamily:
                    'Inter, "Helvetica Neue", "Segoe UI", Roboto, Ubuntu, "Fira Sans", "Noto Sans", Arial, sans-serif',
                lineHeight: 1.5,
                colorScheme: theme,
                border: "1px solid var(--cpd-color-border-subtle)",
                borderRadius: 12,
            }}
        >
            {children}
        </div>
    );
}

/**
 * A whole Matron screen at desktop width: the real MatronApp (sidebar, header, timeline,
 * composer, tracker, files) rendered from a fixture client. Use it as the reference for layout
 * and density, or as a backdrop when designing a single surface in context.
 */
export function MatronScreen({
    screen = "chat",
    theme = "light",
    width = 1180,
    height = 720,
    fixture,
}: MatronScreenProps): React.ReactElement {
    const client = useMemo(() => createFixtureClient({ ...fixture, screen }), [screen, fixture]);
    return (
        <ScreenFrame theme={theme} width={width} height={height}>
            <MatronApp client={client} />
        </ScreenFrame>
    );
}

/**
 * The same real app at phone size (390 x 844 by default). The phone layout is driven by the
 * app's `@media (max-width: 700px)` rules, so it only appears when the page itself is narrow:
 * build phone designs in a phone-width viewport (this card is captured at 438 px wide).
 */
export function MatronMobileScreen({
    screen = "list",
    theme = "light",
    width = 390,
    height = 844,
    fixture,
}: MatronScreenProps): React.ReactElement {
    const client = useMemo(() => createFixtureClient({ ...fixture, screen }), [screen, fixture]);
    return (
        <ScreenFrame theme={theme} width={width} height={height}>
            <MatronApp client={client} />
        </ScreenFrame>
    );
}
