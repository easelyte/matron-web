# matron-web styling primitives

**The canonical reference for all styling work in this repo.** Reach for this before writing any CSS. It exists so we use the shared primitives (design tokens) instead of hardcoded literals — which is what keeps the stylesheet themeable and consistent **without** a CI lint gate. If you're adding a raw `color:`, `font-size:`, or off-grid `padding:`, stop and check whether a token below already covers it.

## Foundation (do not change)

matron-web styles with **plain PostCSS over Element's Compound design tokens** (`--cpd-*`), defined in `src/journal/shell.pcss :root`. No CSS-in-JS runtime. This is a deliberate choice, not a limitation — see `reference_matron_web_styling_foundation` in memory. **Do not adopt** antd / `@lobehub/ui` / Tailwind / any CSS-in-JS. Borrow patterns from other chat UIs, never their frameworks.

Two stylesheets:
- `src/journal/shell.pcss` — the `:root` token definitions + structural chrome (left panel, room list, room header, composer, message bubbles, auth).
- `src/journal/journal.pcss` — journal-specific components (header status clusters, usage bars, cards, etc.).

## The rule

**Tokens, not literals.** Every color, text size, and spacing value routes through a `--cpd-*` token. A raw literal is a defect unless it's on the sanctioned-exceptions list at the bottom. New tokens are allowed only when no existing one fits the semantics — don't invent a parallel palette.

---

## Color primitives

Defined in `shell.pcss :root`; overridden for dark under `[data-theme="dark"]` (single source — see Theming below). Use `var(--cpd-color-...)`, never a hex/rgb literal.

**Semantic roles** (light value → what it's for):
- **Surfaces:** `bg-canvas-default` (panels, bubbles, composer), `bg-canvas-raised`, `bg-subtle-primary` / `bg-subtle-secondary` (hovers, inputs), `bg-room-canvas` (the warm "paper" message-list backdrop), `bg-self-bubble` (outgoing bubble tint), `bg-cluster` (status-pill), `bg-scrim-auth` / `bg-scrim-drag` (translucent overlay panels).
- **Text:** `text-primary`, `text-secondary`, `text-placeholder`, `text-link-external`, `text-critical-primary`, `text-action-accent`.
- **`text-on-accent`** — foreground text/icon on a colored fill (unread badge, submit button). **Never maps to a surface token, never follows the canvas flip** — it stays near-white in both themes, or badge/button text goes dark-on-dark in dark mode.
- **Icons:** `icon-accent-primary`, `icon-secondary`, `icon-tertiary`.
- **Borders:** `border-disabled`, `border-subtle`, `border-interactive-primary` / `-secondary`.
- **Status:** `usage-low` / `usage-medium` / `usage-high` (usage-bar fills — semantic, not raw iOS system colors).

> Some of these tokens are introduced by the #480 refinement children (#487 dark-theme). Until #487 merges, treat rows not yet present in `:root` as **target state**.

## Spacing primitives

The grid is **4 / 8 / 12 / 16 / 20 px** = `--cpd-space-1x` … `--cpd-space-5x`. Use these for `padding` / `margin` / `gap`. Off-grid values (5, 6, 10, 18, 28 …) are strays — snap to the nearest step.

**Do-not-touch pixel tuning** (these are coupled component geometry, NOT grid noise — leave them, or change only with a before/after visual check):
- Message bubble: `.mx_EventTile_line` `padding: 10px 60px 10px 10px` + `margin-left: -9px` + the timestamp `right: 8px / bottom: 7px` (the 60px right pad + -9px tuck position the corner timestamp).
- Bubble rhythm: `.mx_EventTile[data-layout="bubble"]` `margin: 5.5px …` / `margin-top: 1px` (continuation spacing).
- Composer input: `.mx_BasicMessageComposer_input` `margin: 8.5px 0`.

## Type primitives — READ THIS, it's a footgun

The `--cpd-font-body-*` / `--cpd-font-heading-*` tokens are **complete `font` SHORTHANDS** (`<weight> <size>/<line-height> <family>`), e.g. `--cpd-font-body-sm-regular` = `400 14px/20px Inter, sans-serif`.

- **Apply them via `font:`** — `font: var(--cpd-font-body-sm-regular);`. This sets weight + line-height + size + family together (the Compound-native pattern).
- **NEVER** write `font-size: var(--cpd-font-body-sm-regular)` — a full shorthand on the `font-size` property is **invalid CSS**; the browser silently drops the declaration and you get the inherited size.
- **Size-only sites** (element keeps a local weight/line-height that differs from every shorthand): use the **size-only** tokens — `font-size: var(--cpd-font-size-sm);`. Same pixel steps, valid on `font-size`.

Scale steps (both the `font:` shorthands and the `font-size-*` size-only tokens share these): **10 / 12 / 14 / 16 / 18 / 20 px** = `2xs / xs / sm / md / lg / xl` (headings use the semibold shorthand variants). Body default ≈ 15px (`html` root − 1px). Kill fractional (`14.0625px`) and sub-10px (`9px`) literals — snap up to the nearest step.

> The `2xs` / `md` / `heading-sm` / `heading-md` and the `--cpd-font-size-*` size-only scale are introduced by #488 (type-scale). Target state until it merges.

## Theming (light / dark / system)

Dark mode is a **CSS-var override**, single source: the dark values live once under `[data-theme="dark"]` in `shell.pcss`. The active theme is set on `<html>` via `data-theme`:
- **System** (default) — no `data-theme-user` set; a small bootstrap reads `prefers-color-scheme` and sets `data-theme` accordingly, updating on OS change.
- **Light / Dark** — the theme toggle writes `data-theme-user` (persisted in localStorage); when present it wins over system.

**Theme-invariant surfaces stay dark in BOTH themes** — code / diff / terminal-output panels (matches the apple client's fixed-dark diff surface). Do not flip these with the light/dark token swap.

**Sanctioned literals** (exempt from "tokens not literals" — these are deliberately raw):
- Theme-invariant alpha overlays: dark scrims `rgb(18 16 14 / 55%)`, accent tint `rgb(13 189 139 / 18%)`, usage-track overlay `rgb(28,24,20,0.12)`.
- `box-shadow` values.
- The do-not-touch bubble/composer pixel geometry listed under Spacing.

Everything else → a token.
