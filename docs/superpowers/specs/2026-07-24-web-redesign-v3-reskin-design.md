# Design — matron-web redesign v3 reskin port (#497)

**Status:** reviewed — spec-review converged at round 5 (Claude LGTM; Codex residuals = accepted deploy-hardening limitations owned by a follow-up loop)
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`, journal web client)
**Loop:** son-of-anton #497 (`matron-web-redesign-v3-reskin-port`, operator priority 2)
**Origin:** Operator-approved claude-design v3 redesign. Anchor: `docs/design/matron-redesign-v3.dc.html` (React + proprietary DCLogic runtime — REFERENCE ONLY, not mergeable). Token system: `docs/design/primitives-v2.md` (operator-approved 2026-07-23).
**Branch:** `vps-redesign-v3-reskin` off `origin/main`.
**Approach:** B — faithful v3 reskin including the asymmetric bubble model. Chosen over A (card/token refit that keeps symmetric bubbles) and C (reskin + style deferred-feature shells). See Rejected Alternatives.

---

## Constraint

**Upstream-alignment tension (acknowledged, intentional divergence).** matron-web is Dan's fork; `project_matron_web_stays_dan_upstream_aligned` normally argues for minimal-diff, no restructuring. #497 is the deliberate exception: an operator-approved visual fork toward easelyte's own v3 direction that Dan will not merge. To keep the divergence *maintainable* (future upstream logic merges still land), this reskin is **CSS-heavy / TSX-light**:

- All visual change lands in `src/journal/shell.pcss` + `src/journal/journal.pcss`. Single-source `[data-theme="dark"]` block stays in shell.pcss.
- `components.tsx` / `markdown.tsx` changes are **additive presentational markup + presentational-placement conditionals only — no changes to data flow / business logic, no new source files** (operator decision, round 1; wording clarified round 3). This preserves the #448 divergence-minimization intent: the rule guards against forking Dan's *business logic* (which breaks upstream merges). A conditional that places an *existing* presentational node differently by an *already-computed* flag (e.g. render the `<time>` inside the header when `!continuation`, else in the line) is presentational placement, **not** new logic — it does not touch data flow, and is permitted. Permitted changes, total ~20-30 lines: (1) the assistant avatar span (**mandatory**, see §1), (2) the composer static footer-hint row, (3) relocating the flat-message `<time>`+`<a>` into the sender header for `!own && !continuation` tiles — a placement conditional on the existing `continuation` flag; the timestamp renders in exactly one location per tile (header for first-in-group, line for continuation), never duplicated (round-3 B3), (4) a `.mj_CodeBlock_header` **`<span style="display:flex">`** grouping the existing lang + copy nodes into one sticky header row — a `<span>` not a `<div>`, since `<pre>` permits only phrasing content (round-3 M1). The existing disabled mic placeholder is **kept and styled**, not removed (voice capture = #470).
- Styling foundation stays plain PostCSS over `--cpd-*` tokens (`reference_matron_web_styling_foundation`) — **no new deps, no CSS-in-JS**.
- Reskin only. Every new *behavior* is deferred to its own loop (see Scope).

**Principles in play:** P13 (global CSS × platform — verify mobile + both themes, not just desktop light), P18 (cognitive budget — keep the diff a reviewable token-map + refit, not a rewrite), P2 (canonical source — `--m-*`→`--cpd-*` is a one-way token map; the redesign's `--m-*` names do not enter the codebase), P16 (no dead CSS for unbuilt features).

**Accepted P18 file-size debt (round-1 M4).** `shell.pcss` (815 lines) and `journal.pcss` (1701 lines) already exceed the ~400-line cognitive-budget guidance, and this reskin grows both (dark hljs block, diff rules, refits). A split is **out of scope here** for the same divergence-minimization reason as loop #448 (unilateral file restructuring forks Dan's layout and complicates upstream logic merges — a `.pcss` split is the styling analog). **Accept the debt + file a follow-up loop** to propose the split upstream (mirrors #448's channel). This spec's P18 obligation is diff *reviewability* (token-map + refit, no rewrite), which it meets; the file-size axis is explicitly deferred, not ignored.

---

## Scope

### In scope (reskin — this loop)
1. **Message model** — asymmetric bubbles: assistant (non-self) messages flat on the paper canvas with a name header; user (self) messages keep the teal right-aligned bubble. Grouping/continuation visuals.
2. **Code blocks** (`.mj_CodeBlock`) — white card + persistent header bar (filename/lang left, `copy` right) replacing the warm-grey card with hover-only floating buttons.
3. **Diff cards** (`.mj_DiffCard`) — per-line green/red background tints via two new tokens.
4. **Tool-call cards** (`.mj_ToolCard`) — refit to v3 card treatment (surface, radius, header).
5. **Dark syntax highlighting** — `[data-theme="dark"]` hljs token colors (journal.pcss explicitly deferred these "to the parent theme work"; this is that work).
6. **Composer** (`.mx_MessageComposer*`) — pill input + teal filled send circle + footer hint-row styling. (No mic — voice is #470.)
7. **Header** (`.mj_ChatHeader` + clusters) — static-styling refit only.
8. **Sidebar rows** (`.mj_RoomListItem*`) — refit to v3 (largely already tokenized; reconcile residual literals).
9. **Cross-cutting** — replace remaining raw hover / shadow / radius / transition literals with tokens; verify colors/type/spacing/elevation/state-layers in **both themes**.

### Explicitly deferred (NOT this loop)
- 4-metric usage cluster → #501 (needs limits data, dep #447). **Header keeps today's single-context display.**
- Adaptive header collapse (ResizeObserver) → #500.
- Sidebar Active/Favs/Archived tabs → #498 (needs favorite/archived data model). *Note: `.mj_RoomListTab*` styles already exist in journal.pcss; leave them, do not wire behavior.*
- Resizable sidebar → #499.
- Subagent chip strip → #502.
- Inline permission cards → #503 (bridge dependency).
- Voice-note composer (mic) → #470.

**Boundary rule:** do not add markup or CSS for any deferred feature that has no live DOM today (permission card, subagent strip). Refitting styles that already exist and are already rendered (tabs, usage single-metric) is fine; building new shells is #C-rejected.

---

## Token additions

Add to shell.pcss `:root` and `[data-theme="dark"]`. Three new tokens total across this spec: the two diff-background tokens below, plus `--cpd-color-text-on-badge` (see the badge decouple under "Dark on-accent fix"). Everything else maps to the existing v2 set.

```
:root {
    /* diff line backgrounds (v3 --m-diff-add / --m-diff-del, light) */
    --cpd-color-bg-diff-add: rgb(52 199 89 / 0.13);
    --cpd-color-bg-diff-del: rgb(255 59 48 / 0.09);
}
[data-theme="dark"] {
    /* dark uses the softer crit red (#ff6a6a family), lower add opacity */
    --cpd-color-bg-diff-add: rgb(52 199 89 / 0.12);
    --cpd-color-bg-diff-del: rgb(255 107 107 / 0.10);
}
```

**Dark on-accent fix.** v3's `--m-on-accent` dark = `#0b201c` (dark teal-ink on the bright `#2dd4bf`/`#14b8a6` accent), where the current `--cpd-color-text-on-accent` dark is `#f5f7fa` (light text). Bright teal + light text fails contrast; the v3 value is deliberate. Change the dark `--cpd-color-text-on-accent` to `#0b201c`.

**Blast radius — audited every selector referencing the token AND its actual background token (round-1 B1 / round-4 B3: the two accent bg tokens differ in dark, so "uses accent" ≠ "safe to flip"):** dark `--cpd-color-bg-accent-emphasis` = `#14b8a6` (**bright**, `#0b201c` ink passes) but dark `--cpd-color-bg-accent` = `#0f766e` (**deep**, `#0b201c` ink ≈ 3.10:1, **fails AA**).
| Selector | Dark background | `#0b201c` safe? | Action |
|---|---|---|---|
| composer send circle (`.mx_MessageComposer_sendMessage`, per §6) | `--cpd-color-bg-accent-emphasis` `#14b8a6` (bright) | Yes | flips correctly to `#0b201c` |
| `.mj_UploadConfirm_send` (journal.pcss — bg `-emphasis`) | `--cpd-color-bg-accent-emphasis` `#14b8a6` (bright) | Yes | flips correctly |
| **`.mx_Login_submit` (shell.pcss:796-800)** | `--cpd-color-bg-accent` **`#0f766e` (deep)** | **No** — `#0b201c` on `#0f766e` ≈ 3.10:1 (round-4 B3) | **Decouple:** keep light text on login submit in dark — give it an explicit `color: #f5f7fa` (or switch its dark bg to `-emphasis`). `#f5f7fa` on `#0f766e` ≈ 5.10:1, passes AA. |
| **`.mj_UnreadBadge` (shell.pcss:390-398)** | `--cpd-color-bg-badge` (**neutral**; light `#7d756b`, dark `#3a3f46`) | **No** — merely borrows the token | **Decouple** to its own dedicated token `--cpd-color-text-on-badge`, NOT `--cpd-color-text-on-accent`. |

**Badge text value — verified both themes (round-2 B1).** A naive decouple to `--cpd-color-text-primary` fails LIGHT: `#1b1815` on `#7d756b` ≈ 3.90:1 < 4.5 AA (and `#0b201c` on dark `#3a3f46` ≈ 1.4:1 if left on-accent). Use **white both themes**: `--cpd-color-text-on-badge: #fff` → light `#fff` on `#7d756b` ≈ 4.53:1 (passes AA, bare), dark `#fff` on `#3a3f46` ≈ 10.7:1 (comfortable). If execution wants light-theme margin above the 4.53 bare pass, darken light `--cpd-color-bg-badge` one step (e.g. `#6b645b`) and re-verify. The on-accent value change is safe only after **both** the badge and the login submit are decoupled (round-4 B3). Compute-verify all on-accent consumers (send circle, upload-send, login submit, badge) against WCAG AA in **both** themes (acceptance #7).

---

## Component reskin detail

### 1. Message model — asymmetric bubbles (the defining v3 change)

Current: `.mx_EventTile_line` gives **every** tile a white bubble (border + `--cpd-shadow-sm`), self overrides to teal. v3 keeps the bubble for **self only**; assistant messages sit flat on `--cpd-color-bg-room-canvas` with a bolder sender-name header.

DOM today (`components.tsx:1985-2019`, confirmed): `<li.mx_EventTile data-self={own}>` → `.mx_DisambiguatedProfile` (name, rendered only `!own && !continuation`) → `.mx_EventTile_line` (contains the absolute timestamp `<a>` + content). No avatar node is emitted (the `.mx_EventTile_avatar{display:none}` rule targets a legacy Element node absent from this DOM).

**CSS (shell.pcss):**
- Non-self line loses bubble chrome. `.mx_EventTile_line` carries an unconditional `margin-left: -9px` (bubble-edge compensation) and `padding: … 56px …` (right gutter reserved for the absolute timestamp) — both are bubble-specific and must be reset for the flat model (round-1 M2):
  ```
  .mx_EventTile[data-self="false"] .mx_EventTile_line {
      margin-left: 0;                      /* drop bubble-edge compensation (round-1 M2) */
      padding: var(--cpd-space-1x) var(--cpd-space-0-5x);  /* no 56px right gutter — timestamp moved to header */
      border-color: transparent;
      background: transparent;
      box-shadow: none;
  }
  ```
  This aligns the flat text's left edge (`+2px`) with the `.mx_DisambiguatedProfile` header (`+2px` via its `margin-left: var(--cpd-space-0-5x)`).
- Keep self bubble as-is (already correct: teal `--cpd-color-bg-self-bubble`, right-aligned, timestamp absolute bottom-right in the bubble — unchanged).
- Restyle `.mx_DisambiguatedProfile` per v3 (name reads as `--cpd-color-text-primary` weight-600 label, not the current dim secondary meta), laid out as a flex row `name · avatar · timestamp`.

**Timestamp (round-1 M3 / round-2 — resolved under decision (a), additive TSX).** The `<time>` currently lives inside `.mx_EventTile_line` wrapped in `<a href="#event-N" onClick={preventDefault}>` (`components.tsx:2003-2007`). That anchor has **no other consumer** in the codebase (single occurrence; only behavior is suppressing native anchor-jump — grep-confirmed round-2), so it moves or drops freely.
- **Non-self, first-in-group** (`!own && !continuation`, has header): **move the `<a>` wrapper together with its `<time>`** (not the bare `<time>` — leaving the empty `<a>` behind would be a dangling focusable, round-2 m1) into the `.mx_DisambiguatedProfile` header (`components.tsx:1997-2001`) so it renders `avatar · claude · 10:06`.
- **Non-self continuation** (`.mx_EventTile_continuation`, no header): no relocation target. Keep the `<time>`/`<a>` in the line but CSS-restyle as an **always-visible muted micro** (tertiary color, small) — **not** hover-revealed (round-2 M2: `:hover` has no touch trigger, so hover-only would be invisible on the mandatory 390×844 mobile cell, and it would contradict §2's own retirement of hover-only reveal).
  - **Overlap fix (round-3 M3):** the flat-model reset strips the bubble-era 56px right gutter for *all* non-self lines, but `.mx_EventTile_line > a` stays `position:absolute; right:8px; bottom:7px` (shell.pcss:540-544) and `.mx_EventTile_line` is `display:flex; width:fit-content` — so on a continuation tile (timestamp NOT relocated) the absolute timestamp would paint over the trailing message text. Scope the gutter removal to exclude continuations: re-add a modest `padding-right` (enough for the micro timestamp) on `.mx_EventTile_continuation[data-self="false"] .mx_EventTile_line`, OR take the timestamp out of absolute overlay into normal inline flow after the text. First-in-group tiles keep the no-gutter reset (their timestamp moved to the header).
- **Self** (bubble): unchanged (absolute bottom-right in bubble).

**Avatar (mandatory additive span — round-2 Maj3, P38 contract parity).** Render a small robot-glyph avatar span inside the `!own && !continuation` header (`components.tsx:1997-2001`), styled in CSS, as the leading element of the `avatar · name · timestamp` flex row. **Mandatory** (the earlier name-only fallback is removed — it contradicted AC#1's `name · avatar · timestamp` and AC#8's permitted-node list, a P38 single-contract violation).

**General rule — the flat treatment applies to EVERY `data-self="false"` tile (round-2 Codex Maj2 / round-5 Codex B2; stated as a rule, not a per-tile list, to close the whack-a-mole).** There are **multiple** non-self render paths, all emitting `.mx_EventTile data-self="false"` + a `.mx_DisambiguatedProfile`: (i) `EventRow` persisted messages (`components.tsx:1985`), (ii) the `ToolStream` fn (`2023`), (iii) live `textStreams` (`2365-2384`, "agent" header, no timestamp), (iv) the `toolStreams` map (`~2385`). The flat non-self CSS applies to all of them, so **all get the flat treatment and the avatar span in their header** (`avatar · name` / `avatar · agent`; timestamp only where the tile has one — streams correctly have none). The avatar-add is applied to every `.mx_DisambiguatedProfile` render site, not a hand-picked subset. **Gate coverage:** the pre-swap staging behavioral gate (§Deploy invariant 3) exercises a **live streaming assistant response** (populating `textStreams`) and a live tool call, and includes a **real-DOM visual spot-check of those streaming tiles at both viewports on staging BEFORE the swap** (round-5 B2 — the hand-authored harness can't render the streaming branches, and real-DOM visual must not wait until post-swap). The screenshot matrix's "live-ToolStream tile" cell is joined by a "live-textStream tile" cell.

**Continuation:** continuation tiles already collapse top-margin; verify the flat model reads as one grouped run (no stray bubble edges, always-visible muted timestamp) light + dark, desktop + mobile.

### 2. Code blocks (`.mj_CodeBlock`, journal.pcss:796-848)

Current: warm-grey (`--cpd-color-bg-subtle-secondary`) card, top-padding reserved for **absolute** `.mj_CodeBlock_copy`/`_lang` that fade in on hover only.

v3: white (`--cpd-color-bg-canvas-default`) card with a **persistent** header bar — lang/filename left, `copy` right — then the code body. Refit:
- Card background → `--cpd-color-bg-canvas-default`; add `1px --cpd-color-border-subtle` + `--cpd-radius-lg` to match v3 card elevation on the paper.
- Convert the absolute hover buttons into a persistent header bar (round-1 m1 / round-2 B3+M1). DOM today (`markdown.tsx:184-192`, confirmed): `<pre.mj_CodeBlock>` with lang-span + code children + copy-button as **flat siblings**, and the `<pre>` is itself the `overflow-x:auto` scroll container. The flat-sibling flex trick (`flex-wrap`/`order`/`flex-basis:100%`) canNOT form a single pinned full-width header, and two independently-sticky siblings (`left:0` lang / `right:0` copy) overlap or leave no header background on long-line scroll. **Sound fix (additive wrapper node #4, decision (a)):** wrap the lang + copy nodes in a `.mj_CodeBlock_header` **`<span>`** (not a `<div>` — `<pre>` permits only phrasing content, round-3 M1; additive presentational markup in `markdown.tsx`; the code `{children}` stays a direct child of `<pre>`). Then: `.mj_CodeBlock_header { position: sticky; top: 0; left: 0; display: flex; justify-content: space-between; width: 100%; opacity: 1; }` (CSS `display:flex` on a `<span>` works — display isn't gated by HTML content category). — one real header box, lang left + copy right via `justify-content`, pinned top-left so it stays put during both vertical (`max-height:360px`) and horizontal scroll. Drop the hover-only fade + the reserved top-padding hack. Header uses `--cpd-color-bg-canvas-raised` or a hairline separator per v3.
- Body keeps `Fira Code` / `--cpd-font-size-xs`; syntax tokens per §5.

### 3. Diff cards (`.mj_DiffCard`, journal.pcss:1311-1397)

Current: `.mj_DiffLine_add`/`_del` color the **text** only (`--cpd-color-icon-accent-primary` / `--cpd-color-text-critical-primary`). v3 adds a full-width line background tint:
- `.mj_DiffLine_add { background: var(--cpd-color-bg-diff-add); }`
- `.mj_DiffLine_del { background: var(--cpd-color-bg-diff-del); }`
- **Overflow-safe tint (round-1 M1):** `.mj_DiffCard_body` is `overflow-x:auto; white-space:pre`, and each line is a block div whose background paints only its own box (100% of container at layout) — long lines' text overflows visually but the tint would stop at the original viewport width, revealing untinted card past the scroll. Fix: the diff line elements must size to the widest content **and** fill the viewport: `.mj_DiffLine_add, .mj_DiffLine_del, .mj_DiffLine_ctx, .mj_DiffLine_hunk { display: block; width: max-content; min-width: 100%; }`. `width:max-content` grows the box to the longest line; `min-width:100%` fills short lines to the viewport. Apply to all line classes (not just add/del) so ctx/hunk lines share the box model and the tinted lines align. Verify by horizontally scrolling a diff with a line longer than the card — tint must extend the full scrolled width.
- Card surface refit to match v3 (radius/border consistent with code block).

### 4. Tool-call cards (`.mj_ToolCard`, journal.pcss:1262-1309, 1399-1405)

Refit surface + `summary` header to the v3 card treatment (consistent radius/border/elevation with code + diff cards). `<pre>` bodies share the code-block surface rules. Failed-tool state keeps `--cpd-color-text-critical-primary`.

### 5. Dark syntax highlighting (`.hljs*`, journal.pcss:850-888)

The current `.hljs-*` colors are tuned for light. Add a `[data-theme="dark"]` override block giving each token role a dark-canvas-legible color drawn from the dark token set (accent `#2dd4bf` for keywords/types, external-link teal for strings, secondary for comments, critical for numbers/literals, primary weight-600 for titles). Replaces the deferral comment at journal.pcss:888. Verify against the code-block white card in dark (note: card is `--cpd-color-bg-canvas-default` `#1a1c20` in dark — tokens must contrast on that, not on paper).

### 6. Composer (shell.pcss:578-701, journal.pcss:1489-1514)

v3: unified pill input, paperclip left, teal filled send **circle** right, footer hint row. **DOM reality (round-1 CX-1, confirmed `components.tsx:2690-2843`):** the composer renders paperclip + a **disabled mic placeholder** (2822-2829, `aria-disabled`, title "Voice messages are not supported by this journal server") + conditional send button, but **no footer hint row exists**. Corrected scope under decision (a):
- `.mx_BasicMessageComposer_input` → pill (`--cpd-radius-pill` or `--cpd-radius-lg` per v3 corner; confirm against anchor at screenshot time — unresolved Q3), consistent border/focus with the accent ring.
- `.mx_MessageComposer_sendMessage` → filled teal circle (`--cpd-color-bg-accent-emphasis` bg, `--cpd-color-text-on-accent` glyph), replacing the current transparent-bg accent-color glyph. Honors the §Token dark on-accent fix.
- **Mic:** the disabled mic placeholder is **kept and styled** (muted/disabled affordance), NOT removed. Enabling voice capture is #470.
- **Footer hint row (additive TSX span, decision (a)):** add a `.mj_ComposerHint` row below the input rendering the **static** affordance text: left `/ commands · shift+enter for newline`. This is presentational-only, no data. **The dynamic right-side readout in the v3 mock (`ctx 72% · auto-idle in 18m`) is DEFERRED** — it needs live context% + idle-timer data not currently in the composer's scope; that is usage/adaptive telemetry owned by #501 (usage) / #500 (adaptive), and wiring it here would smuggle feature work past the reskin boundary (P16). Ship the static-left hint now; the dynamic-right readout lands with #501/#500.

### 7. Header (`.mj_ChatHeader` + clusters, journal.pcss:77-256)

Static refit only. Keep the existing single-context usage display and grid. Reconcile cluster surface/border/shadow to v3 (`--cpd-color-bg-cluster`, `--cpd-shadow-sm`, `--cpd-radius-lg` already present — verify against v3, adjust type/spacing). **Do not** add usage metrics (#501) or ResizeObserver collapse (#500).

### 8. Sidebar rows (`.mj_RoomListItem*`, shell.pcss:325-408)

Largely already v2-tokenized (selected = `--cpd-state-selected` + teal left-border; hover = `--cpd-state-hover`). Reconcile residual literals against v3, confirm the row rhythm (name label + preview meta + timestamp + unread badge/dot) matches. Leave the existing `.mj_RoomListTab*` styles untouched (their behavior is #498).

---

## Deploy & verification

**Visual-verify loop — reproducible gate (round-1 CX-M2), no MCP perms:**
```
CHROME=/root/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome
# anchor baseline (capture once, the comparison reference):
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1440,900 --virtual-time-budget=8000 \
  --screenshot=/tmp/anchor-v3.png \
  file:///opt/matron/web-journal/docs/design/matron-redesign-v3.dc.html
# harness surface (per viewport):
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=<W,H> --virtual-time-budget=6000 --screenshot=/tmp/x.png <harness-url>
```
Because the live client sits behind login, build a **static harness HTML in `webapp/`** (rimraf'd on next build — recreate as needed) that renders representative markup for each in-scope surface under both `:root` and `[data-theme="dark"]`. Screenshot + Read each and compare against the anchor render before deploying.

**Two distinct gates — CSS-visual vs behavioral (round-2 Codex Maj1).** The static harness verifies *visual* parity only; it renders hand-authored markup and does NOT execute the real React render branches or handlers, so it cannot prove "copy works" (AC#2) or that `components.tsx` renders the relocated timestamp exactly once (no duplicate/omission). Split accordingly:
- **CSS-visual gate (pre-deploy):** the screenshot matrix below, against the harness.
- **Behavioral gate (post-staging-deploy, on the operator's real logged-in session, before close):** confirm copy-button copies; the flat-message timestamp renders once (not duplicated by the relocation, not missing); ToolStream header renders during a live tool call; composer footer hint present. These are real-DOM checks the harness cannot cover.

**Fixed screenshot matrix (the CSS-visual gate — every cell captured + Read):** surfaces { assistant-flat-msg, user-bubble, continuation-run, **live-ToolStream tile**, code-block, diff-card(add+del, incl. a horizontally-scrolled long line), tool-card, composer, header, sidebar-rows } × themes { light, dark } × viewports { desktop **1440×900**, mobile **390×844** }. The mobile column is mandatory (round-1 CX-M1 / P13). **Scroll-state setup (round-2 Codex Maj4):** the overflow cells (scrolled diff line, code-block header pin) require the harness to pre-set `scrollLeft` via an inline `<script>` before capture — a plain screenshot records only the unscrolled state and never exercises the tint-overflow / sticky-header behavior. Capture the **anchor at BOTH viewports** (1440×900 and 390×844) so mobile cells have a same-size reference. Comparison is visual side-by-side (structural/color/spacing parity — pixel-diff not required; the anchor is a different runtime).

**Contrast standard (round-1 CX-M2):** WCAG **AA** — body/label text ≥ 4.5:1, large text (≥18px/14px-bold) and UI-component/icon boundaries ≥ 3:1, both themes. The four on-accent surfaces + the decoupled unread badge (§Token additions) are checked against this explicitly.

**Deploy — REQUIREMENTS, not a verbatim script (round-3: the deploy runbook yielded a finer shell/topology bug every round because a spec shouldn't carry a run-me-literally script — P14). The executable script is authored AND dry-run at execution/plan time; the spec states the invariants it must satisfy.** Repo facts (grep-confirmed): `package.json` build = `rimraf webapp && webpack …`, `webpack.config.mjs:51-57` hardcodes `output.path` → `<repo>/webapp` with `clean:true`; so a build in the live checkout rimrafs live `webapp/` directly and cannot stage in place. Invariants:

0. **Commit-first, one SHA for every gate (round-4 B1 — R702/P19/P38).** The implementation is **committed before the deploy runs**; the deploy builds, validates, screenshots, and swaps **that exact committed SHA** (`SHA=$(git rev-parse HEAD)` after the commit), and the same SHA is what `/ship-slim` PRs and merges. A detached worktree built from the branch tip would otherwise build the pre-change UI while uncommitted edits sit in the live checkout — every gate would pass against code that never ships. The manifest (invariant 5) records `SHA` so evidence, deploy, and merge are provably the same build. So: **commit → build+validate that SHA → all staging gates + operator sign-off → ship/merge → swap (LAST)** — the live swap is the single irreversible step and runs only after every abort-capable gate (review, merge, sign-off) has passed (P19a; matches the plan's T-5.1→T-5.5 ordering). NOT build-then-commit, and NOT swap-before-ship.
1. **Isolated build.** Build in a checkout whose `webapp/` is NOT the live tree, from the committed `SHA`: `git worktree add --detach /tmp/mw-build-$TS "$SHA"` (`--detach` avoids the "branch already checked out here" failure, round-3 B1). Live `webapp/` stays untouched until invariant 4.
2. **Asset-level validation (R702, before any live mutation).** Serve the built tree on a scratch port; assert every hashed JS/CSS bundle referenced by `index.html` returns 200 (root-200 passes even when assets 404).
3. **Behavioral validation BEFORE the swap (round-3 B2 — R702).** The behavioral gate (copy works; relocated timestamp renders exactly once; ToolStream header; composer hint) runs against the **staging** scratch-port server (log in there), NOT post-swap on live. A React-only defect must be caught before it reaches users; the smoke `curl` and the restore-trap cannot detect a *present-but-defective* build.
4. **Guarded swap (R102 + P19).** The forward swap is the destructive-to-live op → gate the whole swap on the R102 confirmation token (not just rollback). Requirements the script must meet: (a) each rename individually guarded so a failure halts + restores — do NOT rely on `mv A && mv B`, whose `&&` chain exempts the first `mv` from `set -e`/`trap ERR` (round-3 B2, verified) → use explicit `mv … || { restore; exit 1; }` per step; (b) same-filesystem swap so the rename is atomic, not copy-and-delete (assert `stat -f` on staging dir and live parent match — `/tmp` and `/opt` are same FS today but the script must check, round-3 M2); (c) a deploy lock (e.g. `flock` on a lockfile) so concurrent runs can't interleave renames (round-3 M3); (d) rename-restore rollback, never blind `rm -rf`; (e) **crash-recovery preflight (round-4 B2):** the deploy script's FIRST step asserts `webapp/` exists and, if absent, restores the newest `webapp.bak.*` before proceeding — so a prior interrupted run self-heals on the next invocation. **Residual (round-5 B3, operator-accepted, follow-up-owned):** a `SIGKILL`/power-loss landing in the sub-second window *between* the two renames leaves no live `webapp/` until the next deploy runs (traps can't fire post-kill). For a manually-run, operator-gated, one-off reskin deploy this ms-window is an accepted operational risk; eliminating it needs the deferred zero-gap symlink-flip scheme + a service-start recovery preflight, which the **deploy-hardening follow-up loop** owns. This spec does not claim the swap survives `SIGKILL`; it claims normal-failure guards + next-run self-heal.
5. **Retained evidence (R700 + P2 canonical, round-3 M4 / round-4 Maj3 / round-5 B1).** Screenshot cells write to a **canonical retained dir** `docs/superpowers/evidence/2026-07-24-reskin/` (not `/tmp`), each named `<surface>-<theme>-<viewport>.png`, with a `manifest.json` tying every cell → the deployed `SHA` + a pass/fail flag + the operator sign-off record. **The evidence is committed in a SEPARATE follow-up commit** (or stored out-of-tree) — it cannot live inside the SHA it evidences, since committing it would produce a different SHA (round-5 B1); the manifest *references* the deployed `SHA`, it is not *contained by* it. This dir is excluded from the backup/worktree cleanup. It is the durable proof AC#10 was met for that SHA.

**Final operator sign-off** on a real logged-in session covers **both themes AND both viewports** (1440×900 + 390×844) against the real React app (round-4 Maj2 — the static harness can't prove real-DOM mobile layout), before closing #497.

*(Deferred to a **follow-up deploy-hardening loop**, out of scope for a visual reskin: the zero-gap symlink-flip release scheme + service-start recovery preflight (the round-5 B3 residual), and stricter cross-actor deploy locking. The invariants above bound them; the reskin ships on the guarded swap.)*

**Ship:** the implementation `SHA` is already committed to `vps-redesign-v3-reskin` (invariant 0) → `/ship-slim` (Codex adversarial on the diff) → PR to easelyte/matron-web → merge. **Provenance (round-5 Maj1 / final-review B3 — a commit-message citation is NOT tree-equivalence):** verify `git merge-base --is-ancestor "$SHA" origin/main`. If the merge squashed/rebased (built `SHA` is not an ancestor) OR conflict-resolution/review-fixes changed any deploy-affecting file, the built artifact is no longer provably == main → **re-enter the deploy at invariant-0 with the merged commit as the new `SHA` and re-run the gates**. Do NOT accept a commit-message citation as provenance. The `manifest.json` records the built/deployed `SHA` and the resulting main commit. Update `docs/design/primitives-v2.md` resume notes / `docs/styling-primitives.md` if the reskin changed any documented primitive.

---

## Acceptance criteria

1. **Every** `data-self="false"` tile (persisted `EventRow`, `ToolStream`, live `textStreams`, `toolStreams`) renders flat on the paper canvas with an avatar header (`avatar · name · timestamp` for first-in-group; `avatar · agent` for streams, no timestamp; always-visible muted timestamp on continuations — no hover-only); user messages keep the teal right-aligned bubble; a grouped run reads as one owner block; flat text left-edge aligns with the header — light **and** dark, desktop **and** mobile, verified on the real streaming DOM pre-swap.
2. Code blocks are white cards with a `.mj_CodeBlock_header` `<span>` wrapper (lang/filename left, `copy` right) that stays pinned during BOTH vertical and horizontal scroll; **copy works** (behavioral gate, run pre-swap on staging); no reserved-padding artifact.
3. Diff add/del lines carry the green/red background tint full-width across horizontal scroll (line elements `width:max-content; min-width:100%`), verified in a `scrollLeft`-set cell; text colors preserved.
4. Tool cards share the v3 card treatment; failed state still critical-colored.
5. Dark-theme syntax highlighting is legible on the dark code-card surface (`#1a1c20`); no light-tuned token bleeds through.
6. Composer is a pill with a teal filled send circle; the existing disabled mic placeholder is kept + styled (not removed); a static footer hint row (`/ commands · shift+enter for newline`) renders; the dynamic ctx%/auto-idle readout is NOT added (deferred to #501/#500).
7. Dark on-accent text = `#0b201c` on the bright-emphasis surfaces (send circle, upload-send) which pass WCAG AA; **`.mx_Login_submit` is decoupled to light text** (its deep-accent `#0f766e` bg fails at 3.10:1 with `#0b201c` — round-4 B3); `.mj_UnreadBadge` is decoupled to `--cpd-color-text-on-badge` and passes AA on its neutral bg in **both** themes (light bare pass ≥ 4.5:1 compute-verified). All on-accent consumers compute-verified AA, both themes.
8. No new source files; `components.tsx`/`markdown.tsx` changes are additive presentational markup + presentational-placement conditionals only (mandatory avatar span + static composer-hint row + flat-message `<a>`+`<time>` relocation via a placement conditional on the existing `continuation` flag, timestamp rendered once per tile + `.mj_CodeBlock_header` `<span>` wrapper), ~20-30 lines, no data-flow/business-logic changes; no CSS-in-JS; no new deps.
9. No markup or CSS added for deferred features lacking live DOM (permission card, subagent strip); no data wiring for deferred usage/adaptive readouts.
10. Deploy meets the §Deploy invariants: **implementation committed first, one `SHA` for build/validate/screenshot/swap/merge** (round-4 B1); isolated **detached-worktree** build of that SHA (live `webapp/` untouched); asset-level + **behavioral validation BEFORE the swap** (staging scratch-port); R102-token-gated swap with per-rename guards (no `mv A && mv B` `set -e` gap), same-FS atomic rename, deploy lock, rename-restore rollback, **crash-recovery preflight** (restore newest bak if `webapp/` absent), `curl 127.0.0.1:8082` → 200 post-swap; CSS-visual screenshot matrix (surfaces × light/dark × 1440×900/390×844, scroll-state set) compared to the anchor at both viewports, evidence retained + manifested to `SHA` in `docs/superpowers/evidence/2026-07-24-reskin/`; final operator sign-off on the real app, **both themes AND both viewports**.

---

## Rejected alternatives

- **A — card/token refit, keep symmetric bubbles.** Everything except the flat-assistant model. Lowest risk, zero grouping-edge surface, but drops the single most recognizable v3 change, so the result would not read as "the redesign." Rejected: operator confirmed the faithful port (B + decision (a)).
- **C — reskin + style deferred-feature shells (permission card, subagent strip, tabs behavior).** Ships dead CSS against DOM that does not exist yet (#498/#502/#503), re-does the work when each feature lands, and violates the loop split + P16. Out of scope.

## Related principles
- Universal P13 (global CSS × platform), P18 (cognitive budget), P2 (canonical source), P16 (deletion / no-dead-code).
- Memory: `project_matron_web_stays_dan_upstream_aligned` (divergence is intentional + acknowledged here), `reference_matron_web_styling_foundation` (plain PostCSS over `--cpd-*`, no new deps).

## Resolved decisions (round 1)
- **TSX scope:** operator picked (a) — additive presentational nodes only (no restructuring/logic). Enables avatar span, static composer-hint row, flat-message timestamp relocation into the header. Mic placeholder kept + styled.
- **Avatar glyph:** included (additive span), **mandatory** — no fallback (round-2 Maj3).
- **Timestamp on flat messages:** relocated into the sender header for first-in-group; **always-visible** muted micro on continuations (round-2 corrected the earlier hover-revealed idea — hover has no touch trigger on mobile). Rendered in exactly one place per tile, never duplicated (round-3 B3).

## Unresolved questions (for execution)
1. **Composer corner radius:** full pill (`--cpd-radius-pill`) vs v3's softer `--cpd-radius-lg` — confirm against the anchor at execution screenshot time. (Cosmetic; not gating.)

*(Round-2 resolved the staging-build mechanism — isolated git worktree, see Deploy runbook — so it is no longer open.)*
