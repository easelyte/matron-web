# Design — matron-web visual refinement pass (#480)

**Status:** design (brainstorm-slim) — revision 3, spec-review converged at 2 rounds (operator cap). R1: rgb-surface coverage, distinct placeholder/icon tokens, single-source dark palette, 20px heading token + reframed tolerance, required ratchet, option (iv) removed, font-size/geometry ownership split, verification matrix. R2: scrim token split (82%/90%), `text-on-accent` split from canvas (dark-mode correctness), `font:` shorthand vs size-only mechanism (shorthand can't sit on `font-size`), touch-tooltip acceptance narrowed, deterministic visual gate, stale reduced-motion ref removed, audit counts corrected. Operator decisions (2026-07-22): §10 all three resolved — ship a System/Light/Dark toggle (#487), title stays dead-center (#489), and the regression gate is `docs/styling-primitives.md` + a memory pointer (NO CI lint).
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Loop:** son-of-anton #480 (parent design brief)
**Scope class:** POLISH — no features. Operator directive: this is a visual refinement, not a capability change.
**Related principles:** P13 (global CSS has non-obvious platform interactions), P16 (deletion is productive work — type-scale normalization is subtraction), P17 (ratchet every migration — a lint keeps ad-hoc sizes/hex from creeping back).
**Rejected alternatives:**
- **A (slim):** dark theme scoped to journal.pcss's 13 tokens + 8 hex only (the loop's literal audit). Rejected: leaves shell.pcss's ~20 hardcoded chrome colors bright white — dark mode would cover the minority of on-screen pixels (the message bubbles) while the left panel, room list, header, and composer stay white. A half-working dark theme is worse than none.
- **C (max):** B plus a semantic-token-layer restructure (rename raw `--cpd-*` into app-semantic tokens, add elevation/motion token families). Rejected: restructuring the token layer fights the upstream-alignment constraint (`project_matron_web_stays_dan_upstream_aligned`) and turns a polish pass into a design-system project. YAGNI for the current gaps.

---

## 0. Why this is a design brief, not an implementation spec

This document is the **parent** of loop #480. Its job is to (1) fix the refinement philosophy and the hard constraints, (2) record the audit precisely — including two corrections to the loop's original numbers, (3) specify the token deltas and normalization strategy per pillar concretely enough that each child can go straight to `/plan-slim`, and (4) define the fan-out boundaries so the children don't collide. **No component code is written from this session** — the operator reviews the direction first; each child then runs its own slim chain.

## 1. Hard constraints (bind every child)

1. **Upstream-alignment** (`project_matron_web_stays_dan_upstream_aligned`, `reference_matron_web_styling_foundation`): **minimal-diff, no file splits, no restructuring, no new stack.** All CSS changes stay inline in the two existing files — `src/journal/shell.pcss` and `src/journal/journal.pcss`. Keep plain PostCSS over Element Compound design tokens (`--cpd-*`). Do **not** adopt antd / `@lobehub/ui` / Tailwind / any CSS-in-JS. Reference chat UIs (LobeHub, open-webui) are pattern-only; borrow craft, never frameworks.
2. **Token-first.** Every color/size/space value that repeats or has semantic meaning routes through a `--cpd-*` token. Hardcoded literals are the defect class this pass eliminates. New tokens are allowed **only** when an existing one doesn't fit the semantics (see §3.2 new-token list) — do not invent a parallel palette.
3. **Polish, not features — with ONE sanctioned exception.** No new interactions, no new panels, no behavior changes, EXCEPT the **System/Light/Dark theme toggle** (operator decision 2026-07-22), which is explicitly in scope for #487 (§3.1). That is the only feature-add; everything else stays polish. The LobeHub agent-operator philosophy must **not** pull any *further* scope toward features. If a change (other than the theme toggle) alters what the app *does* vs how it *looks*, it is out of scope for #480.
4. **Theme-invariant surfaces stay put.** Code, diff, and terminal-output surfaces are dark-on-dark in *both* themes (matches the apple client's `DiffCard` → `TerminalStyle` fixed dark surface). The dark-theme child must **not** flip these to follow the light/dark token swap. (matron-web does not yet render a terminal/diff-dark surface of its own; this is a forward constraint so the dark palette is designed with it in mind.)

## 2. Audit (verified 2026-07-22 against `origin/main` @ 1378e95, `src/journal/`)

### 2.1 Token foundation — clean and complete on the tokenized surface
`shell.pcss :root` defines the live token set. Every `var(--cpd-color-*)` reference across both files resolves to a defined token — **except one**:

- **CORRECTION 1 (undefined-token reference):** `journal.pcss` references `var(--cpd-font-body-md-regular)` but `:root` never defines it (only `xs-regular`, `xs-semibold`, `sm-regular` exist). The reference currently resolves to nothing (font shorthand no-ops → inherited font). The type-scale child **must define** `--cpd-font-body-md-regular` (see §4).

Defined tokens today: 13 color, 3 font (`body-xs-regular`, `body-xs-semibold`, `body-sm-regular`), `--cpd-font-size-root: 16px`, 5 space (`1x`=4 … `5x`=20).

### 2.2 Dark theme — the real surface is bigger than the loop's "8 hex"
The loop audit counted **8 hardcoded hex in journal.pcss**. That is correct for journal.pcss but **materially understates the dark-theme surface**, because the structural chrome lives in `shell.pcss`, which is heavily hardcoded:

- **CORRECTION 2 (dark-theme scope):** `shell.pcss` carries **~22 hardcoded hex + 6 `rgb(...)` = ~28 raw color instances outside `:root`** — `#fff` ×9 raw (left-panel bg, room-list bg, room-header bg, message-bubble bg, composer bg, submit-button text, unread-badge text, …), `#f0f2f5` ×4 raw (hover, search-input bg, composer input border; a 5th occurrence is the `:root` def), `#087f6d` ×3 raw (send button, submit bg, field-focus border; +2 `:root` defs), `#f1efe9` ×2 (room-body "paper" canvas + homepage), plus `#dff7ed` (self-bubble tint), `#737983`/`#8090a3` (placeholder text / composer icon — **distinct grays, ≠ each other, ≠ any existing token**), `#c7cbd1`, and low-alpha `rgb(...)` shadows/scrollbars.
- **rgb() SURFACE literals also escape tokens (Codex round-1 B1):** three `rgb(...)` values are *surface backgrounds*, not shadows, so they are white/near-white in dark mode and a `var()` override cannot reach them: `.mj_HeaderCluster` bg `rgb(255,254,250,0.72)` (journal.pcss:86 — the status-pill surface), the drag-drop overlay `rgb(255 255 255 / 90%)` (journal.pcss:645), and the auth modal `rgb(255 255 255 / 82%)` (shell.pcss:584). **The auth modal is `rgb()`, NOT `#fff`** — the audit narrative above previously mislabeled it. These three MUST be tokenized (§3.2). Genuinely theme-invariant alpha overlays — the dark scrims `rgb(18 16 14 / 55%)` (journal.pcss:660,703), the accent tint `rgb(13 189 139 / 18%)` (shell.pcss:290), the usage-track dark overlay `rgb(28,24,20,0.12)` (journal.pcss:275), and box-shadows — may stay literal, but the child verifies each reads correctly on the dark canvas.
- **A `[data-theme="dark"]` block that overrides only the 13 `:root` tokens leaves every hardcoded literal above white/light.** So the dark-theme child's work is 3-part: tokenize shell.pcss chrome + the rgb() surfaces → tokenize journal.pcss's 8 → add the single-source dark override (§3).

journal.pcss's 8 hardcoded hex: `#34c759`/`#ff9500`/`#ff3b30` (usage-bar fills), `#fff` ×2, `#dff7ed`, `#e1e4e8`, `#fbfaf6`.

### 2.3 Type scale — 15 ad-hoc sizes bypass the font tokens
Counting both files: `14.0625px` (body — fractional, Element FontWatcher legacy), `calc(root - 1px)`=15px (html), `18px` ×2 (room-list h1; the header title cluster is `15px`), `15px`, `14px` ×3 (shell.pcss:183,242,368), `12px` ×4 (journal.pcss:140,160,1044,1117), `11px` (unread badge), `10px` ×3 (one `!important` on timestamps), `9px` (usage row), `0.8125rem` (13px), `0.9em`, `20px`/26px (`.mj_UploadConfirm_title`, journal.pcss:727), `16px`, `100%` (markdown reset). These bypass `--cpd-font-*`. Normalize by **subtraction** onto a small defined scale (§4).

### 2.4 Spacing — mostly on-grid, a few strays; some strays are load-bearing
Grid is 4/8/12/16/20 (`--cpd-space-1x…5x`). Off-grid strays: `padding: 4px 10px` (HeaderCluster), `gap: 6px` (HeaderContextRow), `gap: 5px` (UsageRow), `padding-inline: 6px` (narrow HeaderCluster), and in shell.pcss `margin: 5.5px 20px 0` / `margin-top: 1px` / `margin-bottom: 5.5px` (bubble rhythm), `margin: 8.5px 0` (composer input), `padding: 10px 60px 10px 10px` + `margin-left: -9px` (bubble timestamp gutter), `18px`/`28px` (auth field/heading margins).

- **CORRECTION 3 (do-not-touch spacing):** several "off-grid" values are **pixel-tuned component internals, not arbitrary strays**. The bubble's `padding-right: 60px` + `margin-left: -9px` + `right: 8px` timestamp positioning form one coupled layout (absolute-positioned timestamp tucked into the bubble corner); the `5.5px`/`1px` bubble margins set the continuation-message vertical rhythm. **Blindly snapping these to grid breaks the bubble visual.** The spacing child scopes cleanup to genuinely-arbitrary container paddings/gaps (`4px 10px`, `gap 6px`, `gap 5px`) and treats the bubble-internal + composer-input pixel tuning as **load-bearing / do-not-touch** (or normalizes only with a visual before/after check).

### 2.5 Top banner — clips context/model/limits (root cause)
Render sites: `ChatHeader` / `SubChatHeader` in `components.tsx`. Structure:
- `.mx_RoomHeader` → `min-height: 56px` (shell.pcss).
- `.mj_ChatHeader` → `display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)` — symmetric 3-column: left `mj_ModelContextCluster`, center `mj_HeaderTitleCluster`, right `mj_UsageCluster`.
- Each side cluster is a 38px-tall pill (`.mj_HeaderCluster` border+shadow, `mj_ModelContextCluster`/`mj_HeaderTitleCluster` `height:38px`).
- Right `.mj_UsageCluster`: `height:38px; overflow:hidden`, containing `mj_UsageBars` (3 rows), each `mj_UsageRow` = `grid-template-columns: minmax(34px,auto) 90px minmax(34px,auto)` (label · 90px track · reset-time) ≈ **158px minimum row width**.

**Failure modes (both visible in the reference screenshot):**
1. **Right cluster clips:** when the right `1fr` column is narrower than ~158px, the fixed 90px track + two `minmax(34px,…)` columns overflow, and `overflow:hidden` **hard-clips** the usage bars ("Sessi… / Week… / Fable:" jammed against the window edge, reset-times cut off).
2. **Left cluster clips:** `.mj_HeaderContext` ellipsis-truncates "Context: 1…" — the 38px pill fixes the vertical box, so a long context string is cut rather than wrapped.
3. **Symmetric `1fr auto 1fr` steals width:** the center title reserves `auto` width and both side clusters are forced to share the remainder equally, so a wide title starves both status clusters simultaneously.
4. **56px header is too short** to give the two-line clusters (model line + context line; label line + bars) any vertical breathing room; the `@media (max-width:700px)` block only shrinks tracks (90→58px), it doesn't fix the height or the overflow-clip.

---

## 3. Pillar 1 — Dark theme (`[data-theme="dark"]` + full chrome tokenization)

**Goal:** a genuine dark mode covering the whole surface (chrome + content), via CSS-var override only, zero runtime recompute, no JS framework.

### 3.1 Mechanism — SINGLE-SOURCE (no duplicated value blocks; P2)
The dark token values are defined **exactly once**, under one selector: `[data-theme="dark"]`. **Do NOT** hand-copy the ~20 dark `--cpd-*: value` pairs into a second `@media (prefers-color-scheme: dark)` block — that is the P2 (Canonical Source) / hidden-coupling anti-pattern both round-1 reviewers flagged (a later contrast tweak updates one copy, not the other). Instead, **the `prefers-color-scheme` signal sets the `data-theme` attribute**, so the media query carries no color values:
```css
[data-theme="dark"] { /* the ONE dark token block — ~20 --cpd-* overrides */ }
```
The active theme is set on `<html>` via `data-theme`, driven by a **3-state System/Light/Dark toggle** (operator decision 2026-07-22 — this is in scope for #487):
```ts
// shell bootstrap (src/journal/index.tsx or shell entry):
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
    const user = localStorage.getItem("matron-theme"); // "light" | "dark" | null(=system)
    const theme = user ?? (mq.matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    if (user) document.documentElement.setAttribute("data-theme-user", user);
    else document.documentElement.removeAttribute("data-theme-user");
};
applyTheme();
mq.addEventListener("change", applyTheme); // system changes only take effect when user pref is null
```
- **System** (default): no stored pref → `data-theme` follows `prefers-color-scheme`, live-updating on OS change.
- **Light / Dark**: the toggle writes `localStorage["matron-theme"]` and wins over system.
- Values stay **single-source** — the one `[data-theme="dark"]` block (never a hand-synced `@media` duplicate). The toggle only flips the attribute; the CSS is unchanged.
- **Toggle control placement:** the child's plan-slim picks the exact UI seam (a control in the room-list header actions or a settings affordance) — a small, restrained 3-state switch, no new panel. This is the one deliberate feature-add in an otherwise polish-only pass; keep it minimal.

### 3.2 Token work (3 sub-steps, all inline in the two .pcss files)
**(a) Tokenize shell.pcss chrome** — replace the hardcoded instances with `var()` refs. **Every map below is loss-less: the token's *light* value equals the raw literal it replaces, so light mode stays pixel-identical** (round-1 B1 — the earlier draft collapsed two distinct grays into `text-secondary`, which would have changed light-mode color; that is now split into two exact-value tokens):
| Hardcoded | Token | Light value |
|---|---|---|
| `#fff` — **SURFACE** uses only (panel/list/header/bubble/composer bg) | `--cpd-color-bg-canvas-default` | `#fff` ✓ |
| `#fff` — **FOREGROUND text on a colored fill** (unread-badge text shell.pcss:259, submit-button text shell.pcss:653) | **NEW** `--cpd-color-text-on-accent` | `#fff` |
| `#f0f2f5` (hover, search-input bg, composer input border) | `--cpd-color-bg-subtle-secondary` | `#f0f2f5` ✓ |
| `#c7cbd1` (field border) | `--cpd-color-border-interactive-secondary` | `#c7cbd1` ✓ |
| `#087f6d` (send/submit/focus/link) | `--cpd-color-text-action-accent` | `#087f6d` ✓ |
| `#737983` (composer placeholder, shell.pcss:522) | **NEW** `--cpd-color-text-placeholder` | `#737983` (exact) |
| `#8090a3` (composer icon/send default, shell.pcss:542) | **NEW** `--cpd-color-icon-tertiary` | `#8090a3` (exact) |
| `rgb(255,254,250,0.72)` (status-pill bg, journal.pcss:86) | **NEW** `--cpd-color-bg-cluster` | `rgb(255,254,250,0.72)` (exact) |
| `rgb(255 255 255 / 82%)` (auth modal, shell.pcss:584) | **NEW** `--cpd-color-bg-scrim-auth` | `rgb(255 255 255 / 82%)` (exact) |
| `rgb(255 255 255 / 90%)` (drag overlay, journal.pcss:645) | **NEW** `--cpd-color-bg-scrim-drag` | `rgb(255 255 255 / 90%)` (exact) |

**Phantom entries removed:** `#f7f8fa` (`bg-subtle-primary`) and `#d8dadd` (`border-disabled`) appear **only as `:root` token definitions**, with zero raw-literal usages in either file — nothing to replace. `--cpd-color-bg-subtle-primary` / `--cpd-color-border-disabled` still get dark values in §3.3 (they *are* referenced via `var()` elsewhere), but there is no step-(a) literal-replacement work for them.

**(b) Introduce new semantic tokens** — only where no existing token fits (values below are the *light* values, unchanged visual today; dark values in §3.3):
- `--cpd-color-bg-room-canvas: #f1efe9` — the warm "paper" backdrop of the message list + homepage (distinct from the cool `bg-subtle-*` greys; must stay a first-class token so dark mode can darken it deliberately).
- `--cpd-color-bg-self-bubble: #dff7ed` — the outgoing-message bubble tint.
- `--cpd-color-usage-low: #34c759`, `--cpd-color-usage-medium: #ff9500`, `--cpd-color-usage-high: #ff3b30` — the three usage-bar fills (semantic status colors; currently raw iOS system colors in journal.pcss).
- `--cpd-color-border-subtle: #e1e4e8` — the journal.pcss `#e1e4e8` 1px border.
- `--cpd-color-bg-canvas-raised: #fbfaf6` — the journal.pcss `#fbfaf6` warm raised surface.
- `--cpd-color-text-on-accent: #fff` — foreground text/icon sitting on a colored fill (unread badge, submit button). **Stays near-white in BOTH themes** — it must NOT follow the canvas flip, or dark mode turns badge/button text dark-on-dark (round-2 Codex M3). Distinct from `bg-canvas-default` even though both are `#fff` in light: they carry opposite semantics (surface vs on-accent foreground) and diverge in dark.
- `--cpd-color-text-placeholder: #737983` — composer placeholder (was collapsing into `text-secondary`; kept distinct to preserve light-mode color, round-1 B1).
- `--cpd-color-icon-tertiary: #8090a3` — composer icon/send default (same rationale).
- `--cpd-color-bg-cluster: rgb(255,254,250,0.72)` — the status-pill (`.mj_HeaderCluster`) translucent surface; dark value keeps an alpha so the pill still floats over the room canvas.
- `--cpd-color-bg-scrim-auth: rgb(255 255 255 / 82%)` — auth-modal translucent panel; dark value = translucent near-black.
- `--cpd-color-bg-scrim-drag: rgb(255 255 255 / 90%)` — drag-overlay translucent panel (**90%, distinct from the auth modal's 82%** — kept as its own token so light mode stays pixel-identical; round-2).
- **Theme-invariant alpha overlays stay literal** (verified per §2.2): the dark scrims `rgb(18 16 14 / 55%)`, the accent tint `rgb(13 189 139 / 18%)`, the usage-track overlay `rgb(28,24,20,0.12)`, and box-shadows read acceptably on dark and need no token — the child spot-checks each on the dark canvas.

**(c) Tokenize journal.pcss's 8 hex** using (b)'s new tokens + existing ones.

### 3.3 Dark palette (starting values — child verifies WCAG AA before ship)
Element/Compound-lineage dark, accent preserved and lightened for contrast on dark. **These are a starting point; the child must verify contrast (AA 4.5:1 body text, 3:1 large text + UI borders) and adjust:**
| Token | Light | Dark (start) |
|---|---|---|
| `--cpd-color-bg-canvas-default` | `#fff` | `#16191d` |
| `--cpd-color-bg-canvas-raised` | `#fbfaf6` | `#1e2228` |
| `--cpd-color-bg-subtle-primary` | `#f7f8fa` | `#1e2228` |
| `--cpd-color-bg-subtle-secondary` | `#f0f2f5` | `#24282f` |
| `--cpd-color-bg-room-canvas` | `#f1efe9` | `#121417` |
| `--cpd-color-bg-self-bubble` | `#dff7ed` | `#12352b` |
| `--cpd-color-border-disabled` | `#d8dadd` | `#33373d` |
| `--cpd-color-border-subtle` | `#e1e4e8` | `#2b2f35` |
| `--cpd-color-border-interactive-primary` | `#8f96a0` | `#6b7079` |
| `--cpd-color-border-interactive-secondary` | `#c7cbd1` | `#3a3f46` |
| `--cpd-color-icon-accent-primary` | `#0dbd8b` | `#21c9a0` |
| `--cpd-color-icon-secondary` | `#656d77` | `#8e959f` |
| `--cpd-color-text-action-accent` | `#087f6d` | `#21c9a0` |
| `--cpd-color-text-critical-primary` | `#bd2020` | `#ff6a6a` |
| `--cpd-color-text-link-external` | `#087f6d` | `#21c9a0` |
| `--cpd-color-text-primary` | `#1b1d22` | `#e6e9ee` |
| `--cpd-color-text-secondary` | `#656d77` | `#9aa1ab` |
| `--cpd-color-text-on-accent` | `#fff` | `#f5f7fa` (near-white — does NOT follow canvas) |
| `--cpd-color-text-placeholder` | `#737983` | `#7d848e` |
| `--cpd-color-icon-tertiary` | `#8090a3` | `#7a828d` |
| `--cpd-color-bg-cluster` | `rgb(255,254,250,0.72)` | `rgb(40,44,50,0.72)` |
| `--cpd-color-bg-scrim-auth` | `rgb(255 255 255 / 82%)` | `rgb(22,25,29,0.86)` |
| `--cpd-color-bg-scrim-drag` | `rgb(255 255 255 / 90%)` | `rgb(22,25,29,0.90)` |
| `--cpd-color-usage-low/medium/high` | system | keep hue, verify ≥3:1 on dark track |

**Acceptance (Pillar 1):** with OS dark active, no white/light surface remains anywhere (left panel, room list, room header, composer, bubbles, auth, homepage all dark); accent + status colors remain legible (AA); light mode is pixel-identical to today (the override is additive — light values are unchanged); no JS added beyond (optionally) reading the media query.

## 4. Pillar 2 — Type-scale normalization

**Goal:** kill the 15 ad-hoc sizes; every text size routes through a defined `--cpd-font-*` token. Subtraction, not addition.

### 4.1 Define the scale in `shell.pcss :root` (fills the md gap + adds the missing steps)
| Token | Value | Role |
|---|---|---|
| `--cpd-font-body-2xs-regular` | `400 10px/12px` | micro-labels: timestamps, header model/email, field float-label, usage labels |
| `--cpd-font-body-xs-regular` (exists) | `400 12px/16px` | secondary meta: header context, compact button |
| `--cpd-font-body-xs-semibold` (exists) | `600 12px/16px` | emphasized meta |
| `--cpd-font-body-sm-regular` (exists) | `400 14px/20px` | **body default**, room preview, search input, disambiguated profile |
| `--cpd-font-body-md-regular` | `400 16px/24px` | **DEFINE** (fixes Correction 1) — base reading / larger meta |
| `--cpd-font-heading-sm-semibold` | `600 18px/28px` | room-list `h1`, chat-header title |
| `--cpd-font-heading-md-semibold` | `600 20px/28px` | `.mj_UploadConfirm_title` (journal.pcss:727, currently 20px/26px) — **DEFINE**, so the 20px title has an exact token and doesn't have to round to 18px (round-1 Codex B2) |
(Compound `Inter, sans-serif` family throughout — matches existing token font stack.)

**Mechanism — the `--cpd-font-body-*`/`-heading-*` tokens are complete `font` SHORTHANDS, consumed via `font:`, NOT `font-size:` (round-2 Codex B2).** They expand to `<weight> <size>/<line-height> <family>` (e.g. `--cpd-font-body-sm-regular` = `400 14px/20px Inter, sans-serif`), already used correctly as `font: var(--cpd-font-body-sm-regular)` at shell.pcss:470. You **cannot** write `font-size: var(--cpd-font-body-2xs-regular)` — that puts a full shorthand on the `font-size` property, which is invalid CSS and the browser drops the declaration. So normalization has two mechanisms, and the child picks per site:
1. **Whole-style sites** (the element's weight + line-height + size should all come from the token): replace the `font-size:` (plus any sibling `font-weight:`/`line-height:` that the token already encodes) with a single `font: var(--cpd-font-…);`. This is the Compound-native path and the default.
2. **Size-only sites** (the element keeps a local `font-weight`/`line-height` that differs from every shorthand token — e.g. a 15px title at weight 600 with a bespoke line-height): use a **size-only custom property**. Define the size-only scale alongside the shorthands:
   `--cpd-font-size-2xs: 10px; --cpd-font-size-xs: 12px; --cpd-font-size-sm: 14px; --cpd-font-size-md: 16px; --cpd-font-size-lg: 18px; --cpd-font-size-xl: 20px;` — then `font-size: var(--cpd-font-size-2xs)` is valid and leaves the local weight/line-height untouched.

Both scales share the same pixel steps, so "no raw literal" holds whichever mechanism a site uses.

### 4.2 Mapping (kill list)
- `14.0625px` body → **15px is the intended legacy size** (`root − 1px`); normalize the fractional literal to the `html { font-size: calc(root − 1px) }` rhythm and let body inherit, OR pin body to `--cpd-font-body-sm-regular` (14px). Recommendation: **drop the `14.0625px` line, inherit from `html`** (removes the fractional px; body then = 15px root). Child confirms no regression in bubble text size.
- `18px` (h1, title) → `--cpd-font-heading-sm-semibold`. `15px` header title → also `heading-sm` (unify) **or** `sm`/`md`; child picks one heading size for both.
- `14px` ×3 (shell.pcss:183,242,368) → `--cpd-font-body-sm-regular`.
- `12px` ×4 (journal.pcss:140,160,1044,1117) → `--cpd-font-body-xs-regular` (semibold variant where weight 600 already applied).
- `11px` (unread badge), `10px` ×3, `9px` (usage row) → `--cpd-font-body-2xs-regular` (10px). **9px → 10px** is a deliberate legibility bump (9px is below comfortable minimum); child confirms the usage cluster still fits after the banner redesign (Pillar 4) reflows it — coordinate ordering (see §7).
- `0.8125rem` (13px) → nearest token (`sm` 14px or `xs` 12px; child picks by context). `20px` (`.mj_UploadConfirm_title`) → `--cpd-font-heading-md-semibold` (exact 20px — no forced round to 18px). `16px` → `--cpd-font-body-md-regular`. `0.9em`, `100%` → `inherit`/token per role. `10px !important` timestamp → `2xs` **and drop `!important`** if specificity allows (P-cleanup).

### 4.3 Ratchet (P17) — a documentation gate, NOT a CI lint (operator decision 2026-07-22)
P17 says a migration that removes a pattern must add a gate against its return, or the pattern creeps back within weeks. **The gate is a canonical styling guide + a memory rule that points to it — deliberately NOT a GitHub CI lint** (operator: avoid annoying red-X lint checks; single-maintainer workflow). This is a knowledge gate: the primitives are documented in one place and every styling session (operator or agent) is pointed there, so raw literals aren't reached for in the first place.

Concretely:
- **`docs/styling-primitives.md`** (matron-web) is the canonical reference — the token catalog (color / spacing / font, with the `font:`-shorthand vs `font-size:` size-only footgun spelled out), the theming mechanism, the do-not-touch pixel tuning, and the **sanctioned-literals** list (theme-invariant alpha overlays + box-shadows + bubble/composer geometry stay raw; everything else is a token). The guide is seeded this session (design-brief close-out); each child keeps its section current as it lands (#487 colors + theming, #488 type + spacing). "Tokens not literals" and the sanctioned-exceptions list live in the guide, not in a linter.
- **Memory pointer:** `reference_matron_web_styling_foundation` (always relevant when touching matron-web CSS) carries a pointer to the guide, so future sessions load "reach for `docs/styling-primitives.md` before any styling work."
- **No CI lint step, no stylelint dependency, no `matron-web-css-lint-ratchet` follow-up loop.** (Superseded by this decision.) If we later find the doc gate is being ignored in practice, revisit — but default is docs+memory only.

**Reframed tolerance (Codex B2):** normalization *is* snapping to a scale, so "within ±1px" is the wrong gate — it forbids the very rounding the pillar exists to do. Correct acceptance: **every size maps to its nearest defined scale step; each deviation >1px from today's literal is a deliberate scale-snap that the child enumerates in its plan** (known snaps: `9px→10px` usage legibility bump, `14.0625px→15px` body de-fractioning, `20px/26px→20px/28px` title line-height if the child snaps it). No ad-hoc literal survives; no size is left un-representable.

**Acceptance (Pillar 2):** `--cpd-font-body-2xs`, `-md`, `-heading-sm`, `-heading-md` tokens defined (fixes the undefined-`md` reference); zero raw `font-size` literals in either .pcss except intentional `inherit`/`100%`; every size routes to a defined step with all >1px snaps enumerated in the plan; the type + spacing sections of `docs/styling-primitives.md` updated to reflect the final tokens (§4.3 doc-gate ratchet).

## 5. Pillar 3 — Spacing cleanup

**Goal:** snap the *arbitrary* off-grid strays to `--cpd-space-*`; leave pixel-tuned component internals alone (Correction 3).

### 5.1 Clean (snap to grid) — non-header strays only
Per §7, the header-cluster paddings/gaps (`.mj_HeaderCluster` `4px 10px` + narrow `6px`, `.mj_HeaderContextRow` `gap:6px`, `.mj_UsageRow` `gap:5px`) are **geometry owned by the banner child** (it re-tunes them in the redesign) — the spacing child does **not** touch them. The spacing child's scope is the strays outside the banner blast radius:
- auth `18px`/`28px` margins (`.mx_Field` / `.mx_AuthBody h1`) → `--cpd-space-4x`/`5x`-ish (16/20) — low-traffic screen, safe to snap.
- any other genuinely-arbitrary container `padding`/`gap`/`margin` off the 4/8/12/16/20 grid that the child finds outside the bubble internals (§5.2) and outside the header.
- (The banner child, when it re-tunes the header geometry, routes its final header paddings/gaps through `--cpd-space-*` too — so the "snap to tokens" goal still covers the header; it's just executed by the banner child, not the spacing child.)

### 5.2 Do-not-touch (load-bearing pixel tuning — Correction 3)
`.mx_EventTile_line` `padding: 10px 60px 10px 10px` + `margin-left: -9px` + `.mx_EventTile_line > a { right: 8px; bottom: 7px }` (timestamp gutter); `.mx_EventTile[data-layout="bubble"]` `margin: 5.5px 20px 0` / `margin-top: 1px` / `margin-bottom: 5.5px` (continuation rhythm); `.mx_BasicMessageComposer_input` `margin: 8.5px 0`. Normalize these **only** with an explicit before/after visual check, and prefer leaving them — they are tuned to the bubble/timestamp geometry, not grid noise.

**Acceptance (Pillar 3):** arbitrary container paddings/gaps route through space tokens; bubble + composer pixel tuning unchanged (or changed only with a verified-identical visual); no new off-grid literals introduced.

## 6. Pillar 4 — Top-banner / status-cluster redesign (the one visible bug)

**Goal:** context + model + all 3 usage rows are fully visible (or gracefully degraded) at realistic widths; nothing hard-clips.

### 6.1 Direction (child's brainstorm picks exact values; constraints fixed here)
- **Give the header height.** Raise `.mx_RoomHeader` `min-height` from 56px toward ~64–72px (or `auto` with vertical padding) so two-line clusters + the 3-row usage stack breathe. Header is `flex: 0 0 auto`, so growth pushes the timeline down cleanly.
- **Stop the hard clip.** Remove/replace `overflow:hidden` on `.mj_UsageCluster` as the clip mechanism. **Verify the replacement does not relocate the overflow** — sizing the cluster to content must be paired with a grid that yields the width (see the rebalance bullet), or the timeline/other columns absorb the overflow instead. Options (all pure-CSS / static-markup, no interaction): (i) let the cluster size to its content and give it a guaranteed min-width in the grid; (ii) move the trailing reset-time column into the row's static `title` attribute (native tooltip, not a new interaction) and show only label + bar, cutting ~34px/row; (iii) stack `label` above `bar` per row (taller but narrower). Recommendation: **(ii) + a min-width floor** — keeps all three bars visible, moves the least-critical datum (reset time) into the already-present `title`, smallest change.
- **OUT OF SCOPE (round-1 consensus blocker):** a collapse-to-chip that **expands on hover/tap** is a new interaction (new state/event) and violates hard constraints §1.3 + §6.2 — **not** an option for #480. If the pure-CSS options can't fully satisfy the acceptance at the smallest widths, the child degrades via the native `title` tooltip (ii), it does not add an expand affordance. A richer interactive usage panel is a deferred feature, not polish.
- **Rebalance the grid — title stays DEAD-CENTER (operator decision 2026-07-22, hard constraint).** The title must remain horizontally centered; the de-clip may NOT come from shifting it off-center. So keep the symmetric `minmax(0,1fr) auto minmax(0,1fr)` structure (which centers the `auto` title column) and fix the clip on the sides instead: give the usage cluster a **guaranteed min-width** in its `1fr` track (so it stops losing width to the title) and **cap the title's `auto` column** (`max-width`, already present at `min(360px,38vw)`) so a long title can't starve the sides. Net: title centered, both status clusters get their floor, nothing clips.
- **Left cluster:** allow "Context: …" to stay single-line but never clip mid-value — either widen its column via the rebalance or let the pill grow with the taller header. The full token count is already in the `title` attribute (tooltip), so truncation-with-tooltip is acceptable as a fallback, but the goal is no truncation at ≥ ~420px content width.
- Keep the existing `@media (max-width:700px)` responsive step; update it to match the new layout (its 90→58px track shrink and reduced gaps still apply, but re-tune against the new grid).

### 6.2 Constraints
- No new components/panels (polish scope) — this is CSS + at most trivial markup reshuffle within the existing `ChatHeader`/`SubChatHeader`/`UsageBars` render (e.g. moving reset-time into a `title`). No new client state, no new events.
- Apply the same fix to **both** `mj_ChatHeader` and `mj_SubChatHeader` (they share the cluster classes).
- The approved direction adds **no** hover/expand affordance (option (iv) is out — §6.1), so Pillar 4 needs no new motion. Leave the existing `@media (prefers-reduced-motion: reduce)` block intact; do not introduce any transition/animation that would require a new carve-out.

**Acceptance (Pillar 4):** at content widths from ~360px up (touch and pointer), the **primary data are always fully visible with no hard clip against the pill or window edge** — Context value, model line, and each usage row's label + `%` bar. The **reset-time** is the one secondary datum and is a **pointer-hover progressive enhancement via the native `title`** (round-2 Codex M1 — `title` has no touch activation, so reset-time is intentionally NOT required to be reachable on touch; it is never the *only* place a critical datum lives — the `%` and bar always show). Header height increase does not overlap the timeline; both parent and subchat headers fixed; no new motion introduced. (If the operator wants reset-time reachable on touch too, that's a small feature — a tap-popover — deferred, not #480.)

## 7. Cross-child ordering & collision map

The three children touch overlapping selectors — sequence to avoid rebase thrash:
- **Ownership is by CSS property, not by selector (resolves round-1 M1 — "size" was ambiguous):** the banner child owns **box geometry** on the header selectors — `height`, `min-height`, grid-`template-columns`, `padding`, `gap`, layout. The type-scale child owns **text sizing** on *every* selector, header ones included — via either `font: var(--cpd-font-…)` (whole-style) or `font-size: var(--cpd-font-size-…)` (size-only), per §4.1's mechanism, **never** `font-size: var(--cpd-font-body-*)` (invalid). Sizing and box geometry are different declarations on the same rule, so they **do not collide** even on `.mj_UsageRow`/`.mj_HeaderContext`/`.mj_HeaderModel`. (One caveat: the whole-style `font:` mechanism also sets `line-height`, which the banner child may care about for row height — if the banner child pins a row `line-height` for geometry, the type-scale child uses the size-only mechanism on that selector to avoid overriding it. Noted for the parallel case.) The spacing child owns off-grid `padding`/`gap` **outside** the header (§5.1's header-cluster items — `.mj_HeaderCluster` padding, `.mj_HeaderContextRow`/`.mj_UsageRow` gaps — are **geometry, so they belong to the banner child**, since the banner rework re-tunes them anyway).
- **Banner redesign (Pillar 4) reflows** `.mj_HeaderCluster`, `.mj_UsageCluster`, `.mj_UsageRow`, `.mj_ChatHeader` grid — so it owns those selectors' *geometry*; the type-scale child still swaps their `font-size` tokens.
- **Recommended order:** **Banner first** (settles header geometry), then **type-scale** (swaps font-size tokens onto the final markup), then **spacing** (snaps the remaining non-header strays). Parallel is safe given the property-level ownership split above; if the banner child changes header markup, the type-scale child rebases its font-size swaps onto the new nodes (mechanical).
- **Dark theme (Pillar 1) is orthogonal** on values (it swaps token *definitions* + replaces literals with `var()`), so it can run in parallel with any of the three, EXCEPT it must land the **new tokens** (§3.2b: `usage-*`, `bg-room-canvas`, `bg-self-bubble`, `border-subtle`, `bg-canvas-raised`) that the others may reference. Recommendation: **dark-theme child lands first or coordinates the new-token additions**, since type-scale also adds `:root` tokens (`2xs`, `md`, `heading-sm`) — both children edit the `:root` block, so whichever lands second rebases the token additions (small, mechanical). Flag in each child's loop.

## 7a. Verification contract (binds every child — round-1 consensus major)

The acceptance gates ("pixel-identical light mode", "AA contrast", "no clip ≥360px", "before/after visual check") are only meaningful with a named method. Each child runs the subset of this matrix relevant to its pillar, against a **production build** (P27) — the atomic web-deploy runbook: `corepack pnpm build` in `/opt/matron/web-journal`, served on `:8443` (see `CLAUDE.local.md` deploy runbook). No child ships on a dev-server check alone.

- **Viewport × state matrix.** Widths **~360 / 700 / 1200px** × states **{chat, subchat, auth/login, drag-active (file over composer), empty-conversation, running-session (usage bars present)}**. The banner + dark-theme children exercise the full matrix; type-scale/spacing exercise chat + subchat + auth (where their sizes live).
- **Light-mode pixel-identity (Pillar 1, and the "no visual change" claim of Pillars 2/3) — deterministic capture (round-2 Codex M2, P27).** "Any non-zero delta" is the wrong gate: usage/context counters render live and font anti-aliasing is non-deterministic, so a 0% threshold produces false failures. Instead: **(a) freeze the variable state** — capture both before (`origin/main`) and after (branch) in the *same* conversation with the *same* session data, and **exclude the live-counter region** (`.mj_UsageCluster` numbers, `.mj_HeaderContext` token count) from the light-mode diff (those values legitimately change between captures; their *layout* is covered by the banner acceptance, not this diff); **(b) readiness before capture** — wait for web-font load (`document.fonts.ready`) and no in-flight transition; **(c) a small tolerance**, not 0% — a per-pixel/aggregate threshold that absorbs sub-pixel AA noise (e.g. pixelmatch `threshold≈0.1`, fail only above a small % of differing pixels). Any delta above tolerance, outside the child's enumerated deliberate changes (§4.3 snap list), is a regression. Tooling: a headless screenshot + `pixelmatch`/`odiff`-style diff is preferred; manual side-by-side is acceptable for the auth/empty cells that have no live counters.
- **Dark-mode coverage (Pillar 1).** In OS-dark, walk every matrix cell and confirm **no white/near-white surface** remains — explicitly including the three rgb() surfaces (status pill, auth modal, drag overlay) and the room "paper" canvas.
- **Contrast (Pillar 1).** Every dark token pair carrying text/icons meets WCAG **AA** (4.5:1 body, 3:1 large text + UI/borders). Method: a contrast-ratio check on the §3.3 palette pairs (any WCAG contrast checker / devtools). Enumerate the checked pairs in the child's plan.
- **Reduced motion (Pillar 4).** Any hover/tooltip affordance honors the existing `@media (prefers-reduced-motion: reduce)` block.

## 8. Fan-out — child loops (filed against son-of-anton store on parent close)

1. **`matron-web-dark-theme`** (Pillar 1) — tokenize shell.pcss chrome (~28 raw instances) + the 3 rgb() surfaces + journal.pcss's 8 hex; add ~13 new semantic color tokens (`text-on-accent`, `text-placeholder`, `icon-tertiary`, `bg-cluster`, `bg-scrim-auth`, `bg-scrim-drag`, `bg-room-canvas`, `bg-self-bubble`, `usage-{low,medium,high}`, `border-subtle`, `bg-canvas-raised`); add the **single-source** dark override (§3.1) + the **System/Light/Dark theme toggle** (operator decision — a persisted 3-state control writing `data-theme-user`; see §3.1); update the color + theming sections of `docs/styling-primitives.md` (§4.3 doc-gate ratchet); verify WCAG AA + full dark coverage (no white surface). Owns all `:root` **color**-token additions. Largest child (now includes the toggle control + persistence — a deliberate small feature on top of the tokenization).
2. **`matron-web-type-scale-and-spacing`** (Pillars 2 + 3) — define the font tokens (`2xs`, `md`, `heading-sm`, `heading-md`; fixes the undefined-`md` reference + the 20px title), map the ad-hoc sizes onto them (snaps enumerated), snap non-header spacing strays, leave bubble/composer pixel tuning; **update the type + spacing sections of `docs/styling-primitives.md`** (§4.3 doc-gate ratchet — no CI lint). Owns the `:root` **font**-token additions and `font-size` on every selector. (Pillars 2+3 combined because both are "normalize literals → tokens by subtraction," share the same files, and splitting doubles the rebase surface for near-zero benefit.)
3. **`matron-web-top-banner-redesign`** (Pillar 4) — taller header + right-cluster de-clip (pure-CSS/`title`, **no expand affordance**) + grid rebalance, both parent & subchat headers. Owns all `.mj_*Header*`/`.mj_Usage*` **box geometry** (height, grid, padding, gap) and routes its final header spacing through `--cpd-space-*`; the type-scale child still swaps header `font-size` tokens (property-level split, §7).

Each child: own `/brainstorm-slim` (or straight `/plan-slim` — direction is fixed here) → build → `/ship-slim`, in a `/opt/matron/web-journal` worktree off fork-main, committed to `easelyte/matron-web`. Parent #480 closes when the spec commits + these three are filed.

## 9. Out of scope (YAGNI for #480)
- Markdown rendering of message bodies (that's loop **#479** — separate).
- ~~Manual light/dark toggle control~~ — **now IN scope** (operator decision 2026-07-22): a 3-state System/Light/Dark toggle ships with #487 (§3.1, §1.3 carve-out).
- Semantic-token-layer rename / elevation + motion token families (rejected alternative C).
- Component file splits (`components.tsx` ~1.9k / `client.ts` ~1.4k) — that's loop **#448** (P18 debt), not a visual refinement.
- Any new panel, interaction, or behavior change.
- Motion/animation polish beyond honoring `prefers-reduced-motion` on existing affordances.

## 10. Operator decisions (resolved 2026-07-22)
1. **Dark-theme trigger — RESOLVED: ship a 3-state System/Light/Dark toggle.** Not auto-only. System is the default (follows `prefers-color-scheme`), Light/Dark override it, persisted in localStorage. In scope for #487 (§3.1); the one sanctioned feature-add (§1.3 carve-out).
2. **Center title — RESOLVED: dead-center is a HARD constraint.** The banner de-clip (#489) may not shift the title off-center; fix the clip on the sides via a usage-cluster min-width floor + capped title column, keeping the symmetric centering grid (§6.1).
3. **Regression gate — RESOLVED: documentation gate, not a CI lint.** No GitHub stylelint/CI check. Instead: the canonical `docs/styling-primitives.md` guide (seeded this session, kept current by each child) + a memory rule (`reference_matron_web_styling_foundation`) pointing sessions to it before styling work (§4.3).
