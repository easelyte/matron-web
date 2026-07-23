# matron-web design primitives v2 (research-grounded)

> **OPERATOR-APPROVED 2026-07-23 — "go for it".** Direction: **WARM-neutral** (confirmed). Accent: **brighter teal `#0d9488` light / `#2dd4bf` dark** (confirmed, replaces `#087f6d`/`#0dbd8b`). Preview validated light+dark in the headless harness (`webapp/v2-preview.html`). Now applying the primitives to the real components.
>
> **IMPLEMENTATION STATE (for resume after compaction):**
> - Target repo: `/opt/matron/web-journal` (matron-web, live checkout on `main` @ PR#11 merge). Edit `src/journal/shell.pcss` + `src/journal/journal.pcss`; single-source `[data-theme="dark"]` block in shell.pcss.
> - **Uncommitted on main** (from live polish, must commit with the v2 work): header sizing (`.mx_RoomHeader min-height:84px`, clusters `min-height:58px`, `--mj-header-side-min-width:220px`, `.mj_UsageTrack width:100%`, `.mj_UsageRow font-size:xs`, title `--cpd-font-size-md`).
> - **Deploy runbook (atomic):** `cd /opt/matron/web-journal` → `cp -a webapp webapp.bak.<ts>` → `corepack pnpm build` → verify `curl 127.0.0.1:8082` (nginx upstream to `:8443`). Rollback: `rm -rf webapp && mv webapp.bak.<ts> webapp`. Latest good backup pre-v2: `webapp.bak.20260723T140519Z`.
> - **Visual-verify loop (no MCP perms — use bash):** headless Chrome `/root/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome --headless=new --no-sandbox --window-size=W,H --screenshot=/tmp/x.png http://127.0.0.1:8082/<file>` then Read the png. Build a harness HTML in `webapp/` (rimraf'd on next build — recreate as needed). `v2-preview.html` = the approved mockup.
> - Apply order (highest payoff first): message row+bubble → sidebar item (hover/selected) → composer → header → buttons/chips. Verify each in harness light+dark before deploy.
> - After deploy + operator OK: commit v2 + the uncommitted polish to `main`, push; update `docs/styling-primitives.md` to the v2 primitives.


Goal: replace the ad-hoc, inconsistent styling with a small, coherent set of primitives so the UI reads as one system. Grounded in Radix Colors (12-step interaction/surface model), Material 3 (state layers, type roles), Refactoring UI (non-linear hand-picked scales), Apple HIG (touch targets), and Material dark-theme research (elevation via lightness).

Constraint carried over: plain PostCSS over `--cpd-*` custom properties, single-source `[data-theme="dark"]`, no CSS-in-JS, upstream-aligned. This EXTENDS the token set; it does not change the stack.

## Root cause of "looks off" (current-state audit)
- **No elevation ladder** — warm (`#fbfaf6`, `#f1efe9`) and cool (`#f7f8fa`, `#f0f2f5`) greys mixed with no consistent lightness steps.
- **No interaction system** — 40 hover/focus/active rules, each ad-hoc; no shared hover token, no transition/duration tokens.
- **No radii or shadow scale** — every value a raw literal.
- **Flat linear type ramp** (10/12/14/16/18/20), no role semantics.
- **Only 5 spacing steps** (4–20), nothing for section gaps.

## Design decision: coherent WARM-neutral system
The message canvas is already a warm "paper" (`#f1efe9`) with white bubbles — a distinctive, good instinct. v2 commits to ONE warm-neutral grey ramp (kills the cool greys) so every surface belongs to the same family. (Operator can flip to cool-neutral; the ladder structure is identical, only hues change.)

---

## 1. Spacing — 4px base, non-linear ramp (Refactoring UI)
Keep 4px base; extend with the hand-picked steps modern systems use. No two steps closer than ~25%.
```
--cpd-space-0-5x: 2px;   /* hairline: icon-to-label, inline chip pad */
--cpd-space-1x:   4px;
--cpd-space-2x:   8px;    /* default inner gap */
--cpd-space-3x:   12px;   /* control padding */
--cpd-space-4x:   16px;   /* card padding, row padding */
--cpd-space-5x:   20px;
--cpd-space-6x:   24px;   /* section gap */
--cpd-space-8x:   32px;   /* large section gap */
--cpd-space-10x:  40px;
--cpd-space-12x:  48px;   /* page gutters */
```
Applied rules: message row vertical padding `2x` (compact) / `3x` (comfortable); sidebar item padding `2x 3x`; header padding-inline `4x`; composer padding `3x 4x`; card padding `4x`.

## 2. Type — hand-picked ramp with ROLE tokens (M3 roles, RUI non-linear)
Sizes stay 4px-family but gain roles + tuned line-heights. Inter, Regular(400)/Medium(500)/Semibold(600) only.
```
/* role shorthands (font:) */
--cpd-font-micro:        400 11px/14px Inter;   /* timestamps, usage labels, meta-est */
--cpd-font-meta:         400 12px/16px Inter;   /* secondary meta, context line */
--cpd-font-body:         400 14px/21px Inter;   /* CHAT BODY DEFAULT — 1.5 line-height */
--cpd-font-body-strong:  500 14px/21px Inter;
--cpd-font-label:        500 13px/16px Inter;   /* buttons, sidebar item title */
--cpd-font-title:        600 15px/20px Inter;   /* header title, room-list h1 */
--cpd-font-heading:      600 18px/24px Inter;   /* modal/section headings */
```
Notes: body line-height 1.5 (21px on 14px) — the readability sweet spot vs the current cramped 20px. Title drops to 15px (was the too-big 18px). Measure (max line-length) for message text: **~68ch** (`max-width: 68ch` on the markdown block) — the 45–75ch readability band.

## 3. Surface elevation ladder (Radix steps 1–2 backgrounds; dark = lightness)
Four levels, consistent warm-neutral, each a deliberate lightness step.
| Token | Role | Light | Dark |
|---|---|---|---|
| `--cpd-color-bg-app` | app/window base | `#f4f2ee` | `#121316` |
| `--cpd-color-bg-canvas-default` | panels, bubbles (raised on app) | `#ffffff` | `#1a1c20` |
| `--cpd-color-bg-room-canvas` | message-list paper | `#efece6` | `#151619` |
| `--cpd-color-bg-canvas-raised` | cards, popovers | `#faf8f4` | `#212429` |
| `--cpd-color-bg-overlay` | menus, dialogs | `#ffffff` | `#282c32` |
Dark levels get progressively LIGHTER (Material dark research), not darker; depth = lightness.

## 4. Interaction state layer (Radix 3/4/5 + M3 opacities)
Introduce ONE state model used everywhere, via a neutral overlay token:
```
--cpd-state-hover:    rgb(28 24 20 / 0.05);   /* light: ~5% ink overlay (Radix step 4 feel) */
--cpd-state-active:   rgb(28 24 20 / 0.09);   /* pressed (Radix step 5) */
--cpd-state-selected: rgb(8 127 109 / 0.10);  /* accent-tinted selected row */
/* dark */
[data-theme=dark] { --cpd-state-hover: rgb(255 255 255 / 0.06); --cpd-state-active: rgb(255 255 255 / 0.10); --cpd-state-selected: rgb(33 201 160 / 0.14); }
```
Repeated rule (every hoverable row/button): `background: <surface>; transition: background var(--cpd-dur-fast) var(--cpd-ease); }` + `:hover { background: linear-gradient(var(--cpd-state-hover),var(--cpd-state-hover)) <surface>; }` (overlay composited on the surface — same pattern as M3 state layer). Selected list item uses `--cpd-state-selected` + a 2px accent left-border.

## 5. Focus, transitions, motion
```
--cpd-focus-ring: 0 0 0 2px var(--cpd-color-bg-canvas-default), 0 0 0 4px var(--cpd-color-text-action-accent);
--cpd-dur-fast: 120ms;   --cpd-dur-med: 180ms;
--cpd-ease: cubic-bezier(0.2, 0, 0, 1);   /* M3 standard-decelerate */
```
`:focus-visible { outline: none; box-shadow: var(--cpd-focus-ring); }` everywhere. All state changes transition `--cpd-dur-fast var(--cpd-ease)`. Honor `prefers-reduced-motion` (already present).

## 6. Radii + elevation shadows
```
--cpd-radius-xs: 4px;  --cpd-radius-sm: 6px;  --cpd-radius-md: 8px;
--cpd-radius-lg: 12px; --cpd-radius-xl: 16px; --cpd-radius-pill: 999px;
--cpd-shadow-sm: 0 1px 2px rgb(28 24 20 / 0.06);          /* resting cards/pills */
--cpd-shadow-md: 0 4px 12px rgb(28 24 20 / 0.10);         /* popovers/menus */
--cpd-shadow-lg: 0 16px 48px rgb(28 24 20 / 0.16);        /* modals */
```
Radii usage: chips/badges `pill`; buttons/inputs `md`; cards/bubbles `lg`; modals `xl`. In dark, shadows are near-invisible — rely on the surface lightness ladder for elevation, keep shadows for shape only.

## 7. Icon sizes + hit targets (Apple HIG)
```
--cpd-icon-sm: 14px; --cpd-icon-md: 16px; --cpd-icon-lg: 20px;
```
Interactive controls: min hit target 44×44 on touch (Apple HIG), 32×32 acceptable on pointer-only dense chrome — use `min-height`/`min-width` with the icon centered; pad to the target, don't grow the glyph.

## 8. Density
Two rhythm modes reserved as a future toggle; default = **comfortable**: message rows `padding-block: 3x`, continuation messages `1x`, group gap `4x`. Sidebar stays **compact**: item `2x 3x`. Header pills `min-height: 58px` inside an 84px banner (already applied).

---

## Migration approach
1. Add the new `:root` tokens (spacing 6/8/10/12x, type roles, elevation ladder, state layer, focus/transition, radii, shadows, icon sizes). Additive — nothing breaks.
2. Refit the repeated surfaces to the primitives, in this order (highest visual payoff first): message row + bubble, sidebar item (hover/selected), composer, header, buttons/chips.
3. Replace every raw hover/`box-shadow`/`border-radius`/`transition` literal with its token.
4. Verify light + dark in the headless harness per component before deploy.
