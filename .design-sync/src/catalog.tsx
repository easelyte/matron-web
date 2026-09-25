// design-sync reference cards: the app's icon set and its design tokens, rendered from the real
// modules. Copied by build-pkg.mjs to .ds-sync/pkg/src/ds/; `./tokens.json` is generated there
// by build-pkg from the :root block of src/journal/shell.pcss, so the swatches can't drift from
// the stylesheet. Nothing here ships in the app.
import React from "react";

import * as icons from "../journal/icons";
import * as glyphs from "../journal/tracker/glyphs";
import tokens from "./tokens.json";

type IconComponent = (props: React.SVGProps<SVGSVGElement>) => React.ReactElement | null;

const GLYPH_NAMES = [
    "QuestionGlyph",
    "TaskGlyph",
    "DecisionGlyph",
    "MissionGlyph",
    "MilestoneGlyph",
    "CommentBubbleGlyph",
    "JumpGlyph",
    "ImagePlaceholderGlyph",
] as const;

export interface IconCatalogProps {
    /** "icons" = the app icon set (src/journal/icons.tsx), "glyphs" = the tracker glyphs. */
    set?: "icons" | "glyphs";
    /** Rendered size in px (default 20). */
    size?: number;
    /** Only show names containing this substring (case-insensitive). */
    filter?: string;
}

/**
 * Every icon the app ships, labelled with its export name. Icons are 24-unit stroke SVGs that
 * take `currentColor`, so they inherit the surrounding text colour; size them with CSS
 * (width/height or font-size for the 1em tracker glyphs). All names are exports of this bundle.
 */
export function IconCatalog({ set = "icons", size = 20, filter }: IconCatalogProps): React.ReactElement {
    const source = set === "icons" ? (icons as unknown as Record<string, IconComponent>) : null;
    const names =
        set === "icons"
            ? Object.keys(icons).filter((name) => /^[A-Z]/.test(name))
            : [...GLYPH_NAMES];
    const shown = names.filter((name) => !filter || name.toLowerCase().includes(filter.toLowerCase()));
    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))",
                gap: 8,
                color: "var(--cpd-color-text-primary)",
            }}
        >
            {shown.map((name) => {
                const Icon = (source ? source[name] : (glyphs as unknown as Record<string, IconComponent>)[name])!;
                return (
                    <div
                        key={name}
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 6,
                            padding: "10px 4px",
                            borderRadius: "var(--cpd-radius-md)",
                            background: "var(--cpd-color-bg-canvas-default)",
                            border: "1px solid var(--cpd-color-border-subtle)",
                        }}
                    >
                        <span style={{ display: "inline-flex", width: size, height: size, fontSize: size }}>
                            <Icon width={size} height={size} />
                        </span>
                        <span
                            style={{
                                font: "var(--cpd-font-micro)",
                                color: "var(--cpd-color-text-secondary)",
                                textAlign: "center",
                                wordBreak: "break-word",
                            }}
                        >
                            {name}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

type TokenGroup = "color" | "state" | "radius" | "space" | "shadow" | "font" | "motion" | "other";

const TOKENS = tokens as Array<{ name: string; group: TokenGroup }>;

export interface DesignTokensProps {
    /** Which token family to show (default "color"). */
    group?: TokenGroup;
    /** Only tokens whose name contains one of these substrings (e.g. ["-bg-"]). */
    match?: string[];
}

/**
 * The app's design tokens (CSS custom properties from shell.pcss), shown with their live value
 * in the current theme: colour swatches, radius and spacing samples, shadows and type roles.
 * Style new work with these `var(--cpd-*)` / `var(--mj-*)` names, never raw hex.
 */
export function DesignTokens({ group = "color", match }: DesignTokensProps): React.ReactElement {
    const rows = TOKENS.filter(
        (token) => token.group === group && (!match || match.some((part) => token.name.includes(part))),
    );
    return (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {rows.map(({ name }) => (
                <div
                    key={name}
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: 8,
                        borderRadius: "var(--cpd-radius-md)",
                        background: "var(--cpd-color-bg-canvas-default)",
                        border: "1px solid var(--cpd-color-border-subtle)",
                        minWidth: 0,
                    }}
                >
                    <TokenSample name={name} group={group} />
                    <code
                        style={{
                            font: "var(--cpd-font-micro)",
                            fontFamily: '"Fira Code", ui-monospace, monospace',
                            color: "var(--cpd-color-text-secondary)",
                            overflowWrap: "anywhere",
                        }}
                    >
                        {name}
                    </code>
                </div>
            ))}
        </div>
    );
}

function TokenSample({ name, group }: { name: string; group: TokenGroup }): React.ReactElement {
    const box: React.CSSProperties = { flex: "none", width: 36, height: 36, borderRadius: "var(--cpd-radius-sm)" };
    const value = `var(${name})`;
    if (group === "color" || group === "state")
        return <span style={{ ...box, background: value, border: "1px solid var(--cpd-color-border-subtle)" }} />;
    if (group === "radius")
        return (
            <span
                style={{
                    ...box,
                    borderRadius: value,
                    background: "var(--cpd-color-bg-subtle-secondary)",
                    border: "1px solid var(--cpd-color-border-strong)",
                }}
            />
        );
    if (group === "space")
        return (
            <span style={{ ...box, display: "flex", alignItems: "center" }}>
                <span style={{ width: value, height: 12, background: "var(--cpd-color-bg-accent-emphasis)" }} />
            </span>
        );
    if (group === "shadow")
        return <span style={{ ...box, boxShadow: value, background: "var(--cpd-color-bg-canvas-default)" }} />;
    if (group === "font")
        return <span style={{ flex: "none", width: 36, font: value, color: "var(--cpd-color-text-primary)" }}>Ag</span>;
    return <span style={{ ...box, background: "var(--cpd-color-bg-subtle-primary)" }} />;
}
