/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readdirSync, readFileSync } from "node:fs";

const SHELL = readFileSync("src/journal/shell.pcss", "utf8");
const SHEETS = ["src/journal/shell.pcss", "src/journal/journal.pcss", "src/journal/tracker.pcss"].map(
    (p) => [p, readFileSync(p, "utf8")] as const,
);

/** Comments stripped, so a selector mentioned in a comment can never anchor a block. */
function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `{ … }` block of the rule whose selector starts a line (`:root {`, `[data-theme="dark"] {`). */
export function block(source: string, selector: string): string {
    const css = stripComments(source);
    const match = new RegExp(`^${escapeRegExp(selector)}\\s*\\{`, "m").exec(css);
    if (!match) throw new Error(`Missing ${selector} block`);
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
        if (css[i] === "{") depth += 1;
        if (css[i] === "}") depth -= 1;
        if (depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(`Unterminated ${selector} block`);
}

export function readTokenBlock(theme: "light" | "dark", source: string = SHELL): Map<string, string> {
    const body = block(source, theme === "light" ? ":root" : '[data-theme="dark"]');
    const tokens = new Map<string, string>();
    for (const match of body.matchAll(/(--mj-[\w-]+):\s*([^;]+);/g)) {
        tokens.set(match[1], match[2].replace(/\s+/g, " ").trim());
    }
    return tokens;
}

/** WCAG relative luminance of a #rrggbb / #rgb colour. */
function luminance(hex: string): number {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((o) => {
        const c = Number.parseInt(full.slice(o, o + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [la, lb] = [luminance(a), luminance(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const THEME_INDEPENDENT = /^--mj-(radius|space|icon|font|dur|ease|focus|content)/;

describe("token layer", () => {
    const light = readTokenBlock("light");
    const dark = readTokenBlock("dark");

    it("declares every themed light token in the dark block too", () => {
        const missing = [...light.keys()].filter((name) => !THEME_INDEPENDENT.test(name) && !dark.has(name));
        expect(missing).toEqual([]);
    });

    it("declares no dark token that light lacks", () => {
        const extra = [...dark.keys()].filter((name) => !light.has(name));
        expect(extra).toEqual([]);
    });

    it("defines every --mj token the stylesheets use", () => {
        // The shell's token block, the few tokens a sheet scopes to itself (the tracker's colours) and
        // the ones components set inline (per-box tints, the image frame height).
        const inline = readdirSync("src/journal", { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".tsx"))
            .flatMap((file) => [...readFileSync(`src/journal/${file}`, "utf8").matchAll(/"(--mj-[\w-]+)":/g)])
            .map((match) => match[1]);
        const defined = new Set([
            ...light.keys(),
            ...SHEETS.flatMap(([, css]) =>
                [...stripComments(css).matchAll(/(--mj-[\w-]+):/g)].map((match) => match[1]),
            ),
            ...inline,
        ]);
        const used = SHEETS.flatMap(([, css]) =>
            [...stripComments(css).matchAll(/var\((--mj-[\w-]+)/g)].map((match) => match[1]),
        );
        expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([]);
    });

    it("uses the Mac timeline gradient for the message canvas in both themes", () => {
        expect(light.get("--mj-color-bg-chat-canvas")).toBe("linear-gradient(180deg, #f2f0ea 0%, #e8e5dc 100%)");
        expect(dark.get("--mj-color-bg-chat-canvas")).toBe("linear-gradient(180deg, #1d1b18 0%, #171512 100%)");
    });

    it("never applies the canvas gradient through background-color", () => {
        for (const [path, css] of SHEETS) {
            expect(`${path}: ${/background-color:\s*var\(--mj-color-bg-chat-canvas/.test(css)}`).toBe(`${path}: false`);
        }
    });

    it("uses the Mac panel colours and keeps theme-color in step with them", () => {
        expect(light.get("--mj-color-bg-canvas-default")).toBe("#fff");
        expect(dark.get("--mj-color-bg-canvas-default")).toBe("#262421");
        const html = readFileSync("src/index.html", "utf8");
        const theme = readFileSync("src/journal/theme.ts", "utf8");
        expect(html).toContain('"dark" ? "#262421" : "#ffffff"');
        expect(theme).toContain('"dark" ? "#262421" : "#ffffff"');
    });

    it("uses the Mac brand teal as the accent", () => {
        expect(light.get("--mj-color-text-action-accent")).toBe("#0b6e7d");
        expect(dark.get("--mj-color-text-action-accent")).toBe("#6ecddc");
        expect(light.get("--mj-color-bg-accent")).toBe("#0b6e7d");
        expect(dark.get("--mj-color-bg-accent")).toBe("#0b6e7d");
        expect(light.get("--mj-color-bg-self-bubble")).toBe("#c4f5fb");
        expect(dark.get("--mj-color-bg-self-bubble")).toBe("#123a41");
    });

    it("leaves no literal old-teal values outside the token blocks", () => {
        const oldTeal = /rgb\(13 148 136|#0d9488|#0f766e|#2dd4bf|#14b8a6/i;
        for (const [path, css] of SHEETS) {
            const body = path.endsWith("shell.pcss") ? css.slice(css.indexOf("\nbody {")) : css;
            expect(`${path}: ${oldTeal.test(body)}`).toBe(`${path}: false`);
        }
    });

    it("gives the status colours their system dark variants", () => {
        expect(light.get("--mj-color-usage-low")).toBe("#34c759");
        expect(dark.get("--mj-color-usage-low")).toBe("#30d158");
        expect(dark.get("--mj-color-usage-medium")).toBe("#ff9f0a");
        expect(dark.get("--mj-color-usage-high")).toBe("#ff453a");
    });

    it("defines the Mac shadows, identical in both themes", () => {
        for (const tokens of [light, dark]) {
            expect(tokens.get("--mj-shadow-bubble")).toBe("0 1px 1px rgb(18 16 14 / 0.08)");
            expect(tokens.get("--mj-shadow-sm")).toBe("0 1px 2px rgb(18 16 14 / 0.08)");
            expect(tokens.get("--mj-shadow-md")).toBe("0 3px 10px rgb(0 0 0 / 0.18)");
        }
    });

    it("defines the radius roles the screens use", () => {
        expect(light.get("--mj-radius-bubble")).toBe("8px");
        expect(light.get("--mj-radius-card")).toBe("8px");
        expect(light.get("--mj-radius-card-content")).toBe("12px");
        expect(light.get("--mj-radius-composer")).toBe("10px");
        expect(light.get("--mj-radius-code")).toBe("6px");
        expect(light.get("--mj-radius-field")).toBe("6px");
        expect(light.get("--mj-radius-popover")).toBe("12px");
    });

    it("routes bubbles, cards, composer and modals through the radius roles", () => {
        const shell = SHEETS[0][1];
        const journal = SHEETS[1][1];
        expect(shell).toMatch(/\.mj_EventTile_line \{[^}]*border-radius: var\(--mj-radius-bubble\)/);
        expect(shell).toMatch(/\.mj_ComposerField \{[^}]*border-radius: var\(--mj-radius-composer\)/);
        expect(shell).toMatch(/\.mj_LoginField input \{[^}]*border-radius: var\(--mj-radius-field\)/);
        expect(journal).toMatch(/\.mj_ToolCard \{[^}]*border-radius: var\(--mj-radius-card\)/);
        expect(journal).toMatch(/\.mj_DiffCard \{[^}]*border-radius: var\(--mj-radius-card\)/);
        expect(journal).toMatch(/\.mj_CodeBlock \{[^}]*border-radius: var\(--mj-radius-code\)/);
        expect(journal).toMatch(/\.mj_PromptCard \{[^}]*border-radius: var\(--mj-radius-card-content\)/);
        expect(journal).toMatch(/\.mj_MediaViewer \{[^}]*border-radius: var\(--mj-radius-popover\)/);
    });

    it("defines the system-first font stacks with Inter and Fira Code as fallbacks", () => {
        expect(light.get("--mj-font-family-ui")).toBe(
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Helvetica Neue", "Segoe UI", Roboto, sans-serif',
        );
        expect(light.get("--mj-font-family-mono")).toBe('ui-monospace, "SF Mono", Menlo, "Fira Code", monospace');
    });

    it("declares no literal font family outside the family tokens", () => {
        for (const [path, css] of SHEETS) {
            const withoutTokens = css
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/--mj-font-family-(ui|mono):[^;]+;/g, "");
            expect(`${path}: ${/\bInter\b|Fira Code/.test(withoutTokens)}`).toBe(`${path}: false`);
        }
    });

    it("uses the Mac leading for body text", () => {
        expect(light.get("--mj-font-body")).toBe("400 14px/18px var(--mj-font-family-ui)");
        expect(light.get("--mj-font-body-sm-regular")).toBe("400 13px/17px var(--mj-font-family-ui)");
        expect(light.get("--mj-font-label")).toBe("400 13px/16px var(--mj-font-family-ui)");
    });

    it("keeps 10–11px tertiary text at 3:1 on every dark surface it sits on", () => {
        const ink = dark.get("--mj-color-text-tertiary")!;
        for (const surface of [
            "--mj-color-bg-canvas-default",
            "--mj-color-bg-canvas-raised",
            "--mj-color-bg-subtle-secondary",
        ]) {
            expect(`${surface}: ${contrast(ink, dark.get(surface)!).toFixed(2)}`).toMatch(/: ([3-9]|\d\d)\./);
        }
        expect(dark.get("--mj-color-icon-tertiary")).toBe(ink);
        expect(dark.get("--mj-color-text-placeholder")).toBe(ink);
    });

    it("gives the spinner a track the arc stands out from by luminance, not only hue", () => {
        const journal = SHEETS[1][1];
        expect(journal).toMatch(/\.mj_Spinner \{[^}]*border: 2px solid var\(--mj-color-text-primary\)/);
        expect(journal).toMatch(/\.mj_Spinner \{[^}]*border-top-color: var\(--mj-color-text-action-accent\)/);
        expect(
            contrast(light.get("--mj-color-text-primary")!, light.get("--mj-color-text-action-accent")!),
        ).toBeGreaterThan(2.5);
    });
});

describe("token block parser", () => {
    it("ignores a selector that only appears in a comment inside another block", () => {
        const source = `
:root {
    --mj-color-bg-app: #ffffff;
    /* Overridden per theme in [data-theme="dark"]. */
    --mj-x: { nested };
}

[data-theme="dark"] {
    --mj-color-bg-app: #171512;
}
`;
        expect(readTokenBlock("dark", source).get("--mj-color-bg-app")).toBe("#171512");
        expect(readTokenBlock("light", source).get("--mj-color-bg-app")).toBe("#ffffff");
    });
});

describe("sign-in styles", () => {
    const shell = SHEETS[0][1].replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
        const match = shell.match(new RegExp(`${escapeRegExp(selector)} \\{([^}]*)\\}`));
        if (!match) throw new Error(`Missing ${selector} rule`);
        return match[1];
    };

    it("sizes inputs with border-box so they cannot overflow the column", () => {
        expect(rule(".mj_LoginField input")).toMatch(/box-sizing: border-box/);
        expect(rule(".mj_LoginField input")).toMatch(/width: 100%/);
        expect(rule(".mj_LoginField input")).toMatch(/border-radius: var\(--mj-radius-field\)/);
    });

    it("scrolls instead of clipping on short viewports", () => {
        expect(rule(".mj_Login")).toMatch(/overflow: auto/);
        expect(rule(".mj_Login")).not.toMatch(/align-items: center/);
        expect(rule(".mj_Login_column")).toMatch(/margin: auto/);
    });

    it("lays the screen out as one 390px column on the panel surface with no card", () => {
        expect(rule(".mj_Login")).toMatch(/background: var\(--mj-color-bg-canvas-default\)/);
        expect(rule(".mj_Login_column")).toMatch(/width: min\(390px, 100%\)/);
        expect(rule(".mj_Login_column")).not.toMatch(/box-shadow/);
        expect(rule(".mj_LoginForm")).toMatch(/gap: var\(--mj-space-3x\)/);
    });

    it("keeps the line-art logo visible on the dark surface", () => {
        expect(rule('[data-theme="dark"] .mj_Login_logo')).toMatch(/filter: brightness\(0\) invert\(1\)/);
    });

    it("uses no Element-era class names or tokens", () => {
        for (const [, sheet] of SHEETS) {
            expect(sheet).not.toMatch(/\.mx_[A-Za-z]|-{2}cpd-/);
        }
        // The one remaining mx_ string is the earlier sidebar-width storage key, read for migration.
        const sources = readdirSync("src/journal", { recursive: true, encoding: "utf8" }).filter((file) =>
            /\.tsx?$/.test(file),
        );
        for (const file of sources) {
            const source = readFileSync(`src/journal/${file}`, "utf8").replaceAll('"mx_lhs_size"', "");
            expect(`${file}: ${/\bmx_[A-Za-z]/.test(source)}`).toBe(`${file}: false`);
        }
    });
});

describe("chat styles", () => {
    const light = readTokenBlock("light");
    const dark = readTokenBlock("dark");
    const journal = SHEETS[1][1].replace(/\/\*[\s\S]*?\*\//g, "");
    /** Every declaration block whose selector list names `selector`, joined (grouped rules included). */
    const rule = (selector: string): string => {
        const bodies: string[] = [];
        for (const match of journal.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const selectors = match[1].split(",").map((part) => part.trim().split("\n").pop()?.trim());
            if (selectors.includes(selector)) bodies.push(match[2]);
        }
        if (bodies.length === 0) throw new Error(`Missing ${selector} rule`);
        return bodies.join("\n");
    };

    it("defines the Mac terminal block colours, identical in both themes, at 4.5:1 or better", () => {
        const expected: Record<string, string> = {
            "--mj-color-terminal-bg": "#1f1f1f",
            "--mj-color-terminal-fg": "#dbdbdb",
            "--mj-color-terminal-add": "#73d173",
            "--mj-color-terminal-del": "#e65959",
            "--mj-color-terminal-muted": "#8c8c8c",
        };
        for (const [name, value] of Object.entries(expected)) {
            expect(light.get(name)).toBe(value);
            expect(dark.get(name)).toBe(value);
            if (name !== "--mj-color-terminal-bg") expect(contrast(value, "#1f1f1f")).toBeGreaterThanOrEqual(4.5);
        }
    });

    it("keeps diff counts and the success glyph readable in light mode (text 4.5:1 on white)", () => {
        expect(rule(".mj_DiffCard_added")).toMatch(/color: var\(--mj-color-text-success\)/);
        expect(rule(".mj_DiffCard_removed")).toMatch(/color: var\(--mj-color-text-critical-primary\)/);
        expect(rule(".mj_ToolCard_status_ok")).toMatch(/color: var\(--mj-color-text-success\)/);
        expect(contrast(light.get("--mj-color-text-success")!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(light.get("--mj-color-text-critical-primary")!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark.get("--mj-color-text-success")!, "#262421")).toBeGreaterThanOrEqual(4.5);
    });

    it("drops the diff row-tint tokens nothing uses any more", () => {
        expect(light.has("--mj-color-bg-diff-add")).toBe(false);
        expect(dark.has("--mj-color-bg-diff-del")).toBe(false);
    });

    it("gives tool and diff cards the Mac chrome: shadow, no border", () => {
        for (const selector of [".mj_ToolCard", ".mj_DiffCard"]) {
            expect(rule(selector)).toMatch(/box-shadow: var\(--mj-shadow-sm\)/);
            expect(rule(selector)).not.toMatch(/border: 1px solid/);
        }
    });

    it("renders diff and tool bodies on the terminal block instead of tinted rows", () => {
        expect(rule(".mj_DiffCard_body")).toMatch(/background: var\(--mj-color-terminal-bg\)/);
        expect(rule(".mj_DiffLine_add")).toMatch(/color: var\(--mj-color-terminal-add\)/);
        expect(rule(".mj_DiffLine_add")).not.toMatch(/background:/);
        expect(rule(".mj_DiffLine_del")).toMatch(/color: var\(--mj-color-terminal-del\)/);
        expect(rule(".mj_DiffLine_hunk")).toMatch(/color: var\(--mj-color-terminal-muted\)/);
        expect(journal).not.toMatch(/#1e2127|#dcdcdc/);
    });

    it("paints the diff body's show-more and truncated notes in terminal ink, not page ink", () => {
        // Both sit on the fixed dark terminal surface, where page-secondary ink fails contrast in light mode.
        const rules = [...journal.matchAll(/([^{}]*\.mj_DiffCard_(?:more|truncated)[^{}]*)\{([^}]*)\}/g)];
        expect(rules.length).toBeGreaterThan(0);
        for (const [, , body] of rules) expect(body).not.toMatch(/--mj-color-text-/);
        expect(rules.some(([, , body]) => /color: var\(--mj-color-terminal-muted\)/.test(body))).toBe(true);
    });

    it("keeps the diff header label in page ink, since the header is not on the terminal surface", () => {
        const rules = [...journal.matchAll(/([^{}]*\.mj_DiffCard_label\b[^{}]*)\{([^}]*)\}/g)];
        expect(rules.length).toBeGreaterThan(0);
        for (const [, , body] of rules) expect(body).not.toMatch(/--mj-color-terminal-/);
        expect(rules.some(([, , body]) => /color: var\(--mj-color-text-secondary\)/.test(body))).toBe(true);
    });
});

describe("timeline card sizes", () => {
    const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
    const tracker = strip(SHEETS[2][1]);
    const journal = strip(SHEETS[1][1]);

    it("caps tracker item and milestone cards at the Mac's 360px", () => {
        expect(tracker).toMatch(/\n\.mj_TrackerCard \{[^}]*max-width: 360px/);
    });

    it("draws the jump-to-bottom button as the Mac's 36px floating circle", () => {
        expect(journal).toMatch(/\n\.mj_JumpToBottom \{[^}]*width: 36px;[^}]*height: 36px;/);
        expect(journal).not.toMatch(/\n\.mj_JumpToBottom \{[^}]*border: 1px solid/);
    });
});

describe("tracker styles", () => {
    const tracker = SHEETS[2][1].replace(/\/\*[\s\S]*?\*\//g, "");
    /** Every declaration block whose selector list names `selector`, joined (grouped rules included). */
    const rule = (selector: string): string => {
        const bodies: string[] = [];
        for (const match of tracker.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const selectors = match[1].split(",").map((part) => part.trim().split("\n").pop()?.trim());
            if (selectors.includes(selector)) bodies.push(match[2]);
        }
        if (bodies.length === 0) throw new Error(`Missing ${selector} rule`);
        return bodies.join("\n");
    };

    it("sizes item rows like the Mac Decisions list", () => {
        expect(rule(".mj_TrackerItemRow")).toMatch(/padding: 6px 12px/);
        expect(rule(".mj_TrackerItemRow")).toMatch(/gap: 10px/);
        expect(rule(".mj_TrackerItemRow_glyph")).toMatch(/width: 20px/);
        expect(rule(".mj_TrackerItemRow_title")).toMatch(/font: 500 13px\/17px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_TrackerItemRow_body")).toMatch(/font: 400 11px\/14px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_TrackerItemRow_meta")).toMatch(/font: 400 10px\/14px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_TrackerItemRow_thumb")).toMatch(/width: 40px/);
        expect(rule(".mj_TrackerItemRow_thumb")).toMatch(/border-radius: var\(--mj-radius-sm\)/);
    });

    it("reads the item detail at a 640px measure and 16px body", () => {
        // A 640px text column at any width, and never wider than its pane (content-box overflowed by 32px).
        expect(rule(".mj_TrackerDetail_scroll")).toMatch(/max-width: calc\(640px \+ 2 \* var\(--mj-space-4x\)\)/);
        expect(rule(".mj_TrackerDetail_scroll")).toMatch(/box-sizing: border-box/);
        expect(rule(".mj_TrackerComposer")).toMatch(/max-width: calc\(640px \+ 2 \* var\(--mj-space-4x\)\)/);
        expect(rule(".mj_TrackerItemTitle")).toMatch(/font: 600 22px\/28px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_TrackerItemBody")).toMatch(/font: 400 16px\/24px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_TrackerItemBody")).toMatch(/box-shadow: var\(--mj-shadow-sm\)/);
        expect(rule(".mj_TrackerThread")).toMatch(/gap: 18px/);
        expect(rule(".mj_TrackerComment_agent")).toMatch(/border-radius: 10px/);
        expect(rule(".mj_TrackerComment_user")).toMatch(/border-radius: 10px/);
        // The context block (mission, owner conversation): secondary captions, one line each,
        // truncated.
        expect(rule(".mj_TrackerContext_row")).toMatch(/color: var\(--mj-color-text-secondary\)/);
        expect(rule(".mj_TrackerContext_row")).toMatch(/max-width: 100%/);
        expect(rule(".mj_TrackerContext_text")).toMatch(/white-space: nowrap/);
        expect(rule(".mj_TrackerContext_text")).toMatch(/text-overflow: ellipsis/);
        // Paragraph margins must not pad the cards top and bottom.
        expect(rule(".mj_TrackerProse > :first-child")).toMatch(/margin-top: 0/);
        expect(rule(".mj_TrackerProse > :last-child")).toMatch(/margin-bottom: 0/);
    });

    it("keeps small tracker text at 4.5:1 on the canvas and on comment cards", () => {
        const css = SHEETS[2][1];
        const lightNeedsYouText = /:root[^{]*\{[^}]*--mj-needsyou-text:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
        expect(lightNeedsYouText).toBeDefined();
        expect(contrast(lightNeedsYouText!, "#e8e5dc")).toBeGreaterThanOrEqual(4.5);
        expect(rule(".mj_TrackerItemRow_status_needsyou")).toMatch(/color: var\(--mj-needsyou-text\)/);
        expect(rule(".mj_TrackerItemRow_status_muted")).toMatch(/color: var\(--mj-color-text-secondary\)/);
        expect(rule(".mj_TrackerComment_time")).toMatch(/color: var\(--mj-color-text-secondary\)/);
    });

    it("falls back to a resizable two-line reply box where field-sizing is unsupported", () => {
        expect(tracker).toMatch(
            /@supports not \(field-sizing: content\)\s*\{\s*\.mj_TrackerComposer_input \{[^}]*resize: vertical/,
        );
    });

    it("gives the reply bar the chat composer's field and a glyph send", () => {
        expect(rule(".mj_TrackerComposer_input")).toMatch(/box-shadow: var\(--mj-shadow-sm\)/);
        expect(rule(".mj_TrackerComposer_input")).toMatch(/border-radius: var\(--mj-radius-composer\)/);
        expect(rule(".mj_TrackerComposer_input")).toMatch(/min-height: 32px/);
        expect(rule(".mj_TrackerComposer_send")).toMatch(/background: transparent/);
        expect(rule(".mj_TrackerComposer")).toMatch(/background: transparent/);
        expect(rule(".mj_TrackerComposer_input")).toMatch(/field-sizing: content/);
        expect(rule(".mj_TrackerComposer_input")).toMatch(/max-height: 144px/);
        expect(rule(".mj_TrackerComposer_send")).toMatch(/color: var\(--mj-color-text-action-accent\)/);
    });

    it("keeps the reply field border-box, themed and shrinkable across both of its rules", () => {
        // Two top-level rules style the field (the shared textarea rule, then the reply-bar layer);
        // what matters is what they add up to.
        const bodies = [...tracker.matchAll(/\n\.mj_TrackerComposer_input \{([^}]*)\}/g)].map((m) => m[1]).join("\n");
        expect(bodies).toMatch(/box-sizing: border-box/);
        expect(bodies).toMatch(/background: var\(--mj-color-bg-canvas-default\)/);
        expect(bodies).toMatch(/color: var\(--mj-color-text-primary\)/);
        // A flex child with field-sizing must be allowed to shrink, or a long URL widens the bar.
        expect(bodies).toMatch(/min-width: 0/);
    });
});

describe("memory styles", () => {
    const tracker = SHEETS[2][1].replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
        const match = tracker.match(new RegExp(`\\n${escapeRegExp(selector)} \\{([^}]*)\\}`));
        if (!match) throw new Error(`Missing ${selector} rule`);
        return match[1];
    };

    it("uses only tokens that exist (the memory rules referenced undefined size/weight tokens)", () => {
        const defined = new Set([
            ...readTokenBlock("light").keys(),
            ...[...tracker.matchAll(/(--mj-[\w-]+):/g)].map((match) => match[1]),
        ]);
        const used = [...tracker.matchAll(/var\((--mj-[\w-]+)/g)].map((match) => match[1]);
        expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([]);
    });

    it("titles the memory form with the name, not a caps section header", () => {
        expect(rule(".mj_TrackerMemoryForm .mj_TrackerSection_header")).toMatch(/text-transform: none/);
        expect(rule(".mj_TrackerMemoryForm .mj_TrackerSection_header")).toMatch(
            /font: 600 17px\/22px var\(--mj-font-family-mono\)/,
        );
        expect(rule(".mj_TrackerMemoryForm .mj_TrackerCaption")).toMatch(/text-transform: none/);
        expect(rule(".mj_TrackerMemoriesHead .mj_TrackerCaption")).toMatch(/text-transform: none/);
        expect(rule(".mj_TrackerMemoriesHead .mj_TrackerButton")).toMatch(/white-space: nowrap/);
        // Only Save spans the form: the delete confirm reuses the same action-row classes beside Cancel.
        expect(rule(".mj_TrackerMemoryForm_save")).toMatch(/width: 100%/);
        expect(tracker).not.toMatch(/\.mj_TrackerConfirm_actions \.mj_TrackerButton \{[^}]*width: 100%/);
    });

    it("styles memory rows like the Mac list: mono medium name, capsule type chip", () => {
        expect(rule(".mj_TrackerMemoryRow_name")).toMatch(/font: 500 13px\/17px var\(--mj-font-family-mono\)/);
        expect(rule(".mj_TrackerMemoryRow_type")).toMatch(/border-radius: var\(--mj-radius-pill\)/);
        expect(rule(".mj_TrackerMemoryRow_desc")).toMatch(/font: 400 13px\/17px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_TrackerMemoryRow_meta")).toMatch(/font: 400 10px\/14px var\(--mj-font-family-ui\)/);
    });
});

describe("project styles", () => {
    const tracker = SHEETS[2][1].replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
        const match = tracker.match(new RegExp(`\\n${escapeRegExp(selector)} \\{([^}]*)\\}`));
        if (!match) throw new Error(`Missing ${selector} rule`);
        return match[1];
    };

    it("lays the dashboard out as the Mac's card grid", () => {
        expect(rule(".mj_ProjectsGrid")).toMatch(
            /grid-template-columns: repeat\(auto-fill, minmax\(min\(300px, 100%\), 1fr\)\)/,
        );
        expect(rule(".mj_ProjectsGrid")).toMatch(/gap: 16px/);
        expect(rule(".mj_ProjectCard")).toMatch(/border-radius: 12px/);
        expect(rule(".mj_ProjectCard")).toMatch(/padding: 14px/);
        expect(rule(".mj_ProjectCard_title")).toMatch(/font: 600 16px\/20px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_ProjectCard_status")).toMatch(/-webkit-line-clamp: 3/);
        expect(rule(".mj_NeedsYouPill")).toMatch(/background: #d70015/); // white 10px text needs 4.5:1; #ff3b30 is 3.5:1
    });

    it("styles the project page header, cards and two columns", () => {
        expect(rule(".mj_ProjectPage_title")).toMatch(/font: 700 26px\/32px var\(--mj-font-family-ui\)/);
        expect(rule(".mj_ProjectCardSection")).toMatch(/border-radius: 12px/);
        expect(tracker).toMatch(
            /@container \(min-width: 900px\)\s*\{\s*\.mj_ProjectPage_columns \{[^}]*grid-template-columns: 1fr 0\.8fr/,
        );
        expect(rule(".mj_ProjectNeedsYou")).toMatch(/background: rgb\(255 59 48 \/ 0\.06\)/);
    });
});

describe("sidebar styles", () => {
    const shell = SHEETS[0][1].replace(/\/\*[\s\S]*?\*\//g, "");
    /** Every declaration block whose selector list names `selector`, joined (grouped rules included). */
    const rule = (selector: string): string => {
        const bodies: string[] = [];
        for (const match of shell.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const selectors = match[1].split(",").map((part) => part.trim().split("\n").pop()?.trim());
            if (selectors.includes(selector)) bodies.push(match[2]);
        }
        if (bodies.length === 0) throw new Error(`Missing ${selector} rule`);
        return bodies.join("\n");
    };

    it("sizes rail labels to the measured width of 'Conversations' at 10px Inter (verified by screenshot)", () => {
        // ~70px at 10px Inter with -0.2px tracking; the Mac's 60pt frame only fits it in SF.
        expect(rule(".mj_NavRail_entry")).toMatch(/width: 70px/);
        expect(rule(".mj_NavRail_label")).toMatch(/max-width: 70px/);
        expect(rule(".mj_NavRail_label")).toMatch(/letter-spacing: -0\.2px/);
    });

    it("lets the snippet truncate before the time on a row's meta line", () => {
        expect(rule(".mj_ConversationListMeta")).toMatch(/display: flex/);
        expect(rule(".mj_ConversationListSnippet")).toMatch(/text-overflow: ellipsis/);
        expect(rule(".mj_ConversationListTime")).toMatch(/flex: none/);
    });

    it("uses the sidebar surface for the rail and list, and a white search field on it", () => {
        expect(rule(".mj_Sidebar_outerWrapper")).toMatch(/background: var\(--mj-color-bg-sidebar\)/);
        expect(rule(".mj_ConversationSearch_inputWrapper")).toMatch(/background: var\(--mj-color-bg-canvas-default\)/);
    });
});
