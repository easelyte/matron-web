/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Design-drift ratchet (2026-09-26 polish). The control-height system lives in shell.pcss tokens
 * (--mj-control-h-sm / --mj-control-h / --mj-control-h-lg / --mj-control-h-touch) and the
 * primitives in controls.pcss. These checks read the stylesheets as source, so a regression fails
 * here before it ships:
 *
 *  - a literal control-band height (24–48px) outside the named exemptions below;
 *  - a var() that points at a custom property nobody defines (it silently falls back, or makes the
 *    whole declaration invalid, which is how gap: var(--cpd-space-1-5x) rendered as 0);
 *  - a component rule restating height / type / radius / padding for a class that is rendered on
 *    top of a primitive (mj_Btn, mj_Input, mj_Seg_item), which is how one filter row ended up
 *    with 36px fields next to a 32px toggle;
 *  - a px height inside controls.pcss itself (the primitives must read the scale).
 *
 * The runtime counterpart, scripts/visual/audit-controls.mjs, measures the rendered rows.
 */

import fs from "node:fs";
import path from "node:path";
import postcss, { type Declaration, type Rule } from "postcss";

const DIR = path.join(__dirname, "..");
const SHEETS = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".pcss"))
    .map((file) => ({ file, root: postcss.parse(fs.readFileSync(path.join(DIR, file), "utf8"), { from: file }) }));

const HEIGHT_PROPS = /^(height|min-height|max-height|block-size|min-block-size|max-block-size)$/;
const BAND_MIN = 24;
const BAND_MAX = 48;

// Literal control-band heights that are NOT controls, each with the reason it is exempt. Keyed by
// the rule's selector (whitespace-normalised). Adding to this list is a design decision; say why.
const HEIGHT_EXEMPT: Record<string, string> = {
    ".mj_HeaderDivider": "a hairline divider, not a control",
    ".mj_UploadThumb": "a thumbnail tile",
    ".mj_MediaViewer_pageThumb": "a thumbnail tile",
    ".mj_MediaViewer_thumb": "a thumbnail tile",
    ".mj_MediaViewer_downloadGlyph": "an illustration glyph box",
    ".mj_FilesGeneric_icon": "an illustration glyph box",
    ".mj_VoiceRecording": "the recording bar replaces the composer row and keeps its 44px footprint",
    ".mj_VoiceRecording_waveform, .mj_VoiceRecording_waveformFallback": "a waveform canvas",
    ".mj_TurnCard_toggle": "the v6 turn-card summary row (owned by the turn-card design, one row in every state)",
    ".mj_HeaderChip": "a non-interactive status chip (role=status)",
    ".mj_ConnectionBanner": "a banner container, not a control",
    ".mx_EventTile_line": "a timeline row",
    ".mx_Field input": "the sign-in floating-label field (label rides inside the box)",
    ".mj_TrackerDetail_head": "a pane sub-header row",
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const where = (d: Declaration): string => `${path.basename(d.source?.input.from ?? "")}:${d.source?.start?.line}`;
const ruleOf = (d: Declaration): Rule | undefined => (d.parent?.type === "rule" ? (d.parent as Rule) : undefined);

describe("design drift ratchet", () => {
    it("keeps literal control-band heights on the token scale", () => {
        const offenders: string[] = [];
        for (const { root } of SHEETS)
            root.walkDecls(HEIGHT_PROPS, (d) => {
                const m = /^(\d+(?:\.\d+)?)px$/.exec(d.value.trim());
                if (!m) return;
                const v = Number(m[1]);
                if (v < BAND_MIN || v > BAND_MAX) return;
                const sel = norm(ruleOf(d)?.selector ?? "");
                if (HEIGHT_EXEMPT[sel]) return;
                offenders.push(`${where(d)} ${sel} { ${d.prop}: ${d.value} } — use var(--mj-control-h*)`);
            });
        expect(offenders).toEqual([]);
    });

    it("has no stale height exemptions", () => {
        const seen = new Set<string>();
        for (const { root } of SHEETS)
            root.walkDecls(HEIGHT_PROPS, (d) => {
                if (/^\d+(\.\d+)?px$/.test(d.value.trim())) seen.add(norm(ruleOf(d)?.selector ?? ""));
            });
        expect(Object.keys(HEIGHT_EXEMPT).filter((sel) => !seen.has(sel))).toEqual([]);
    });

    it("uses a radius token for every radius", () => {
        const RADIUS = /^(var\(--cpd-radius-[a-z]+\)|calc\(var\(--cpd-radius-[a-z]+\) - \dpx\)|50%|0|inherit)$/;
        const offenders: string[] = [];
        for (const { root } of SHEETS)
            root.walkDecls(/radius$/, (d) => {
                const parts = d.value.trim().split(/\s+(?![^(]*\))/);
                if (!parts.every((part) => RADIUS.test(part)))
                    offenders.push(`${where(d)} ${norm(ruleOf(d)?.selector ?? "")} { ${d.prop}: ${d.value} }`);
            });
        expect(offenders).toEqual([]);
    });

    it("keeps every px font size on the type scale", () => {
        const SCALE = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20]);
        const EXEMPT: Record<string, string> = {
            html: "the root size (15px, derived from --cpd-font-size-root)",
            ".mj_InlineCode": "inline code is sized relative to the prose around it (em)",
            ".mj_TrackerItemRow_thumb": "an emoji glyph used as a thumbnail, not text",
        };
        const offenders: string[] = [];
        for (const { root } of SHEETS)
            root.walkDecls(/^(font|font-size)$/, (d) => {
                const sel = norm(ruleOf(d)?.selector ?? "");
                if (sel === ":root" || EXEMPT[sel]) return;
                // Strip var() fallbacks: a defined token wins, and undefined ones fail elsewhere.
                const value = d.value.replace(/var\([^)]*\)/g, "");
                // The size is the first px length (a shorthand's line-height follows its slash).
                const size = /(\d+(?:\.\d+)?)px/.exec(value);
                if (size && !SCALE.has(Number(size[1]))) offenders.push(`${where(d)} ${sel} { ${d.prop}: ${d.value} }`);
                if (/\d(em|rem)\b|calc\(/.test(value)) offenders.push(`${where(d)} ${sel} { ${d.prop}: ${d.value} }`);
            });
        expect(offenders).toEqual([]);
    });

    it("defines every font token on the type scale", () => {
        // Rules use var(--cpd-font-*); this checks the tokens themselves, so a token edit to an
        // off-scale size cannot slip past the per-rule check.
        const SCALE = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20]);
        const offenders: string[] = [];
        for (const { root } of SHEETS)
            root.walkDecls(/^--(cpd-font|mj-font)/, (d) => {
                const size = /(\d+(?:\.\d+)?)px/.exec(d.value);
                if (size && !SCALE.has(Number(size[1]))) offenders.push(`${where(d)} ${d.prop}: ${d.value}`);
            });
        expect(offenders).toEqual([]);
    });

    it("draws one focus ring (var(--mj-focus-ring) with a token offset)", () => {
        const OFFSET_EXEMPT: Record<string, string> = {
            ".mj_MobileNav_tab:focus-visible": "the ring sits inside the 52px tab's touch padding",
        };
        // `outline: none` on focus-visible only where another element carries the indicator.
        const NONE_OK: Record<string, string> = {
            ".mx_BasicMessageComposer_input:focus, .mx_BasicMessageComposer_input:focus-visible":
                ".mx_MessageComposer_row:focus-within draws the accent border around the whole composer",
            ".mj_UploadConfirm_caption:focus, .mj_UploadConfirm_caption:focus-visible":
                "design v5 neutral-focus exception: the caption is autofocused on open, so its focus is the darker border, not an accent ring",
        };
        const offenders: string[] = [];
        const composerRow = SHEETS.some(({ root }) => {
            let ok = false;
            root.walkRules(/^\.mx_MessageComposer_row:focus-within$/, (r) =>
                r.walkDecls("border-color", () => void (ok = true)),
            );
            return ok;
        });
        if (!composerRow) offenders.push("the composer's focus-within border (NONE_OK replacement) is gone");
        for (const { root } of SHEETS)
            root.walkRules(/:focus-visible/, (rule) => {
                rule.walkDecls("outline", (d) => {
                    if (d.value.trim() === "none" && NONE_OK[norm(rule.selector)]) return;
                    if (!/^var\(--mj-focus-ring\)$/.test(d.value.trim()))
                        offenders.push(`${where(d)} ${norm(rule.selector)} { outline: ${d.value} }`);
                });
                rule.walkDecls("outline-offset", (d) => {
                    if (OFFSET_EXEMPT[norm(rule.selector)]) return;
                    if (!/^(var\(--mj-focus-offset[\w-]*\)|0)$/.test(d.value.trim()))
                        offenders.push(`${where(d)} ${norm(rule.selector)} { outline-offset: ${d.value} }`);
                });
            });
        expect(offenders).toEqual([]);
    });

    it("sizes square controls from the scale on both axes", () => {
        // A token height with a literal width turns a 32x32 button into a 32x44 pill on phones.
        const offenders: string[] = [];
        for (const { root } of SHEETS)
            root.walkRules((rule) => {
                let tokenHeight = false;
                rule.walkDecls(/^(height|min-height)$/, (d) => {
                    if (/var\(--mj-control-h(-lg)?\)/.test(d.value)) tokenHeight = true;
                });
                if (!tokenHeight) return;
                rule.walkDecls(/^(width|min-width)$/, (d) => {
                    const m = /^(\d+)px$/.exec(d.value.trim());
                    if (m && Number(m[1]) >= BAND_MIN && Number(m[1]) <= BAND_MAX)
                        offenders.push(`${where(d)} ${norm(rule.selector)} { ${d.prop}: ${d.value} }`);
                });
            });
        expect(offenders).toEqual([]);
    });

    it("never references an undefined custom property", () => {
        const defined = new Set<string>();
        for (const { root } of SHEETS) root.walkDecls(/^--/, (d) => void defined.add(d.prop));
        const offenders: string[] = [];
        for (const { root } of SHEETS)
            root.walkDecls((d) => {
                for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g))
                    if (!defined.has(m[1])) offenders.push(`${where(d)} ${d.prop}: ${d.value}`);
            });
        expect(offenders).toEqual([]);
    });

    it("sizes every primitive from the scale (controls.pcss heights are tokens)", () => {
        const controls = SHEETS.find((s) => s.file === "controls.pcss");
        expect(controls).toBeDefined();
        const offenders: string[] = [];
        controls!.root.walkDecls(/^height$/, (d) => {
            if (!/^(var\(--(mj-control-h|cpd-icon)[\w-]*\)|auto|100%)$/.test(d.value.trim()))
                offenders.push(`${where(d)} ${d.prop}: ${d.value}`);
        });
        expect(offenders).toEqual([]);
    });

    it("does not let a component rule restate what its primitive owns", () => {
        // Classes that the TSX renders alongside a primitive class in the same className.
        const PRIMITIVE = /\bmj_(Btn|Input|Seg_item)\b/;
        const coClasses = new Set<string>();
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== "__tests__") walk(p);
                } else if (entry.name.endsWith(".tsx")) {
                    const src = fs.readFileSync(p, "utf8");
                    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
                        const value = m[1] ?? m[2] ?? "";
                        if (!PRIMITIVE.test(value)) continue;
                        for (const c of value.match(/\bmj_[A-Za-z]+(?:_[A-Za-z]+)*/g) ?? [])
                            if (!/^mj_(Btn|Input|InputIcon|Seg)(_|$)/.test(c)) coClasses.add(c);
                    }
                }
            }
        };
        walk(DIR);
        expect(coClasses.size).toBeGreaterThan(5);

        // A co-class may override what its primitive owns only for a named role.
        const OWN_EXEMPT: Record<string, string> = {
            mj_FileWrite_textarea: "a code editor: monospace type and a tall minimum are its role",
        };
        for (const c of Object.keys(OWN_EXEMPT)) coClasses.delete(c);

        const OWNED =
            /^(height|min-height|font|font-size|line-height|border-radius|padding|padding-top|padding-bottom|padding-block)$/;
        const offenders: string[] = [];
        for (const { file, root } of SHEETS) {
            if (file === "controls.pcss") continue;
            root.walkRules((rule) => {
                // Only the subject (last compound) of each selector matters: `.mj_X svg` styles the icon.
                const subjects = rule.selectors.map(
                    (s) =>
                        s
                            .trim()
                            .split(/[\s>+~]+/)
                            .pop() ?? "",
                );
                const hit = subjects.find((subject) =>
                    [...coClasses].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(subject)),
                );
                if (!hit) return;
                rule.walkDecls(OWNED, (d) => {
                    offenders.push(
                        `${file}:${d.source?.start?.line} ${norm(rule.selector)} { ${d.prop} } — owned by the primitive`,
                    );
                });
            });
        }
        expect(offenders).toEqual([]);
    });
});
