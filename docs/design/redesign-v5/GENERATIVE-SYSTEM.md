# Generative system — the decisions the pixels don't carry

A reflection pass over building this design. Everything in `design-tokens.json` and `static/` describes **what the artifact is**. This file describes **the rules I was applying**, so the system extends correctly to screens I never drew and to real data I never saw. Where I made a judgement call and could have gone the other way, I say so.

Read this when you have to build something the mock doesn't show. If this file and the measured artifact disagree, the artifact wins on values — but this file wins on *intent*.

---

## 1. Responsive priority — the order of sacrifice

The static states show 760 and 560 as snapshots. The rule behind them is a strict order: as the chat pane narrows, things degrade in this sequence, and never out of order.

**Header, in order of what goes first:**

1. **Usage detail** — the 2×2 grid collapses to ctx-only + hover popover (at 760). Ctx is the meter you act on; the rate limits are reference. This is first because it frees ~130px for one lost glanceable value.
2. **Compact button** — hidden (at 560). It has a keyboard/menu path; it is the only header control that is purely convenient.
3. **Subtitle detail** — `model · workdir · status` → status dot + short model name (at 560). Workdir goes before model: you usually have one project per session but switch models within it. Status survives as a dot because "is it running" is the highest-frequency glance in the app.
4. **Title** — truncates, never hides, never wraps to two lines. It is the only thing that tells you which session you are typing into.
5. **Never sacrificed**: the title itself, the ctx bar, the send affordance, the connection status in the sidebar footer.

**Sidebar row, in order:**

1. Preview line truncates.
2. Timestamp shortens (`10:06` → `Wed` → `21 Jun`) rather than being dropped.
3. Session name truncates.
4. **Never dropped**: the status glyph column (8px, fixed) and the unread badge. If space is desperate, lose the preview line entirely before either of those.

**Message canvas:** prose max-width (680px) shrinks with the pane; code and diff bodies scroll horizontally rather than wrapping; the 32px agent indent is the *first* thing to give up below ~420px (drop to 0 and rely on the avatar row alone).

**Composer:** the hint row is the first casualty — it drops below ~420px. The attach/mic/send buttons never collapse into a menu; they are 32px and always visible.

**General rule:** at any width, one glance must answer *which session*, *is it running*, *how full is context*. Everything else is negotiable.

---

## 2. Content ranges I assumed, and what to do outside them

This is where a clean mock and real data part company. Per variable-length element: what I drew for, and the required behaviour beyond it.

| Element | Drawn for | Beyond it |
|---|---|---|
| Session name | 18–34 chars | Ellipsis, `title` attr with the full string. Never wrap. Assume up to ~200 chars from `/workdir` paths. |
| Session preview | 30–50 chars | Ellipsis at one line. Newlines in the source collapse to spaces first. |
| Header title | 18–40 chars | Ellipsis + the title popover (already designed) carries the full value. |
| Workdir | one path, ≤40 chars | Middle-ellipsis is acceptable here (`/opt/…/web-journal`) — the tail is more informative than the middle. The only place I'd allow middle-ellipsis. |
| Agent prose | 1–6 paragraphs | No cap. Long turns are the norm; do not add "show more". |
| Own message | 1–3 lines | Bubble grows; `overflow-wrap: anywhere` so an unbroken 400-char token cannot widen the column. |
| Code block | ≤40 lines | Scrolls vertically past ~360px, horizontally always. Never soft-wrap code. |
| Diff | ~8 rows, +6/−2 | Expanded body caps at ~360px then scrolls. Beyond ~400 rows, render the head and lean on "Open file ↗" — a 4000-line diff must not be a 4000-row DOM. |
| Tool output | 3 lines | Caps at 280px then scrolls; `Load full output` for blob-backed output; `Preview truncated` when truncated. |
| Filename | 20–45 chars | Ellipsis. **No extension is legal** — do not derive the icon from the extension alone; fall back to a generic file glyph. |
| Usage meters | 4 | 2×2 grid; a 5th and 6th flow into a third column and the cluster scrolls horizontally. Fewer than 4: the grid shrinks, rows do not stretch. |
| Subagent pills | 0–4 | Strip scrolls horizontally; each pill caps at ~240px. **Zero pills = hide the strip entirely**, do not leave an empty 41px bar. |
| Unread count | 1–2 digits | 3 digits widen the pill (`min-width` not fixed); beyond 999 show `999+`. |
| Upload queue | 1–3 files | Thumbnail strip scrolls; the `n of N` chip is authoritative, not the thumbnails. |
| Session list | 5–8 rows | Zero → the empty-state copy (seven variants, exact strings in `copy.emptyStates`). 200 rows → plain scroll, no virtualisation requirement at this scale, no grouping headers (deliberate: see anti-goals). |
| Agent turn with only an image | not drawn | Valid. The avatar/name/time header still renders; the image card sits at the 32px indent like prose. Do not special-case it into a bubble. |
| Empty agent turn | not drawn | Should not render at all. If the payload is empty, drop the turn rather than showing a naked header. |

---

## 3. Accessibility intent

Decisions I made while designing that never reached the export. These are design intent, not implementation suggestions.

**Focus order** follows visual order: sidebar (brand → new session → tabs → search → rows → footer), then header (title disclosure → usage → compact → menu), then the thread, then the composer (attach → textarea → mic → send). The composer is deliberately last so `Shift+Tab` from the textarea reaches the thread.

**Focus restoration**, always to the element that opened the thing:
- Upload modal closes → focus returns to the attach button.
- Slash palette closes → focus stays in the textarea, caret intact (the palette never takes focus in the first place; it is driven by the textarea's key handler).
- Header popovers close → focus returns to the trigger.
- A prompt/permission card resolving → focus moves to the composer, because answering means it is your turn again.

**Hover must never steal focus.** The usage and title popovers open on hover *and* on click/focus; the hover instance is decorative and non-focusable. If a popover is opened by keyboard it must be dismissible with `Escape` and must not close on `mouseleave`.

**Live regions:**
- The activity line ("claude is working") is `aria-live="polite"` — it is the primary signal that the agent is alive.
- A new agent turn arriving is `polite`, not `assertive`. Bursts of tool output must not machine-gun a screen reader; announce the turn, not each card.
- Permission requests are the one `assertive` case — they block progress and expire.
- Usage bars are `role="progressbar"` with `aria-valuenow` and an accessible label from the **long** limit name, not the short one: `ctx` is a visual abbreviation, "context 72 percent" is what should be read.

**Screen-reader text for state that is visual-only:** the status dot needs "running" / "idle" text; the teal left bar on the selected row needs `aria-current`; the spinner in a subagent pill needs "working"; the unread dot needs a count or "unread".

**Targets:** 32px is the desktop minimum I designed to; on touch every interactive element must reach 44px, which is why the composer buttons are 32px *icons* with padding to grow, not 32px hit areas.

---

## 4. Transition choreography

The still frames are endpoints. The sequences between them were decided and are not arbitrary.

- **Popover open:** on hover after ~0ms (no delay — this is a dense tool, not a marketing page), fades in over 120ms. On close, no delay either. A hover popover closes on `mouseleave`; a clicked one pins until click-away or `Escape`.
- **Card expand/collapse:** the chevron rotates over 120ms; the body appears immediately. I deliberately did **not** animate height — a diff expanding by 300px with an animated height makes the thread jump under the reader.
- **Send:** the bubble appears at final position with no entrance animation; the composer clears; scroll pins to bottom. If the user has scrolled up, do **not** yank them down — show the jump-to-bottom affordance instead. That distinction matters more than any animation.
- **Streaming agent turn:** text appends; the activity line sits *below* the turn while it streams and disappears when the turn completes. Never move the activity line above the content.
- **Recording:** entering swaps the input row for the recording bar in place, no slide. Stopping returns the input row with the transcript already in it and the caret at the end — the user's next action is almost always to edit or hit Enter.
- **Upload queue advance:** on Send, the modal stays open and its contents swap (counter, filename, thumbnail ring, cleared caption). The dialog itself must not close and reopen — it reads as one continuous task.
- **Theme switch:** instant. No cross-fade. A 200ms colour transition on a full app reads as a bug.
- **Anything that appears while the user is typing** (a new turn, a permission card) must not move the composer or steal the caret.

---

## 5. Component parameter space

The full API per component, including combinations the static states don't show. This is what makes it a system rather than 20 screens.

**PromptCard** — one component, one flag:
`{ kind: "question" | "permission", options: string[] (0..n), allowsFreeText: boolean, answered: boolean, readOnly: boolean, expired: boolean }`
- `kind` changes exactly three things: border tint, label text, and whether the first option renders as primary. Nothing else.
- `options: []` + `allowsFreeText: false` is legal and must still render the free-text row (that is what the live code does) — otherwise the card is a dead end.
- `answered` replaces the entire action area with one line. `readOnly` hides actions with no replacement line.
- Valid but undrawn: a permission card with 5 options (wrap to two rows, only the first is primary); a question with both options *and* free text (options row above, input row below).

**Card (tool / diff / generic)** — `{ collapsible: boolean, open: boolean, status: "ok" | "failed" | "expired" | "loading", header: nodes, body: nodes }`. `failed` tints the border critical and the badge red; it never changes the layout. A card with no body must render as a non-collapsible header row (no chevron).

**Usage meter** — `{ meters: [{ label, percent, resetsAt }], emphasisIndex: 0, collapsed: boolean }`. 1–6 meters valid. `percent` may be `null` → render the track with no fill and no percentage, never a zero-width fill that reads as 0%.

**Session row** — `{ status: "running" | "idle", pinned, favorite, unread: number | boolean, isSubagent, selected, archived }`. These compose: a pinned favourite unread subagent row is legal. Precedence in the 8px glyph column when several apply: **spinner (subagent working) > running dot > favourite star > pin > idle dot**. Only one glyph ever shows.

**Button** — `variant: primary | secondary | ghost | ghostDanger | icon`, `size: sm (28) | md (30) | lg (34)`, `state: rest | hover | active | focus | disabled`. There is exactly **one primary per action group** — if you find two filled buttons side by side, one is wrong.

**Bubble** — `{ own: boolean, position: "single" | "first" | "middle" | "last" }`. `own: false` is not a bubble at all; it is prose (see anti-goals).

---

## 6. Derivation rules — how to extend without asking me

- **Elevation is a surface step, not a shadow.** A thing that sits on top of another moves one rung up the ladder (`--m-paper` → `--m-panel` → `--m-raised` → `--m-overlay`) and gains a border. Shadows only mark things that genuinely float: popovers (`--m-sh-md`) and the modal (`--m-sh-lg`).
- **New surface? Never invent a colour.** Pick the adjacent rung. If two adjacent surfaces need separating, add a `1px solid var(--m-line)` — not a new grey.
- **Accent is for one thing at a time.** Teal marks *the* action, *the* selection, *the* live thing. Two teal elements competing in one region means one should be `--m-ink2`.
- **Text colour is a three-step hierarchy, always:** `--m-ink` for content, `--m-ink2` for labels and metadata, `--m-ink3` for hints and timestamps. Never introduce a fourth step; if something needs to recede further, make it smaller, not lighter.
- **Type: pick the nearest existing role.** If nothing fits, the answer is almost always that the element belongs to an existing role and the design is wrong, not that a new size is needed. (I found ten accidental sizes in my own file doing exactly this check.)
- **Radii scale with the box:** ≤20px tall → 4px, ≤34px → 8px, cards → 10px, modals → 14px, anything pill-shaped → 999px.
- **Density:** dense control rows use 7–9px gaps; content regions use 8/12/16. When in doubt, 12px.
- **Grouped repeats tighten:** consecutive same-author bubbles tighten inner corners to 4px and drop to 2px vertical gaps; the group's last item carries the tail. Generalise this to any repeated element that belongs to one act.
- **Mono is semantic, not decorative.** Fira Code means "this is a literal the system will interpret": paths, commands, percentages, counts, tokens. Never for prose, never for emphasis.

---

## 7. Anti-goals — deliberate choices, please don't "fix" them

- **No bubbles on agent turns.** Agent output carries code, diffs, tool cards; a bubble around them wastes 2×13px of horizontal space per nesting level and fights the card borders. Prose + a 32px indent is the choice. (Confirmed to match the live app.)
- **No entrance animations.** Not on messages, not on cards, not on the modal. Motion is reserved for genuinely live state (three keyframes only: pulse, spin, wave). A tool that animates on every message becomes exhausting by hour two.
- **No gradients, no glows, no coloured shadows.** Depth comes from the lightness ladder and hairlines.
- **No avatars for the operator.** You know who you are. The agent gets a mark because there may be several agents.
- **No fixed-dark code surface.** Code follows the theme. (This reverses an earlier direction in the repo docs; it was decided deliberately after seeing a dark block on warm paper.)
- **No date/day grouping headers in the sidebar.** The list is short and running-first ordering matters more than chronology.
- **No unread count on the app title / no badges beyond the row.** This is a single-operator tool; there is no inbox to triage.
- **No "show more" on long agent turns.** Reading is the point.
- **No accent focus ring on the upload caption** — the dialog autofocuses it, so a teal ring makes every upload read as active. It focuses neutral. (This one looks like an inconsistency and is not.)
- **No middle-ellipsis anywhere except the workdir.**

---

## 8. Uncertainties — all five resolved (2026-07-25, Fantin)

These were flagged as soft. All five came back confirming the defaults, so they are now **decided** and should be treated as intent, not preference:

1. **Usage thresholds (<50 / 50–84 / ≥85)** — **flat and percentage-based across every meter.** Explicitly *not* per-meter and *not* timeframe-aware. My "make them per-meter" suggestion is withdrawn; don't implement it.
2. **2×2 usage grid** — **keep.** Not a row of four.
3. **Session ordering** — **pins at the top**, then the rest. This resolves the conflict I couldn't: pinning outranks running-first, and running-first orders within each group. The app already sorts this way.
4. **Subagent rows in the sidebar *and* pills under the header** — **keep both.** They answer different questions ("what exists" vs "what's working right now").
5. **Mic position** — **keep** it right of the textarea, left of send.

Nothing in this design is awaiting a decision from the product side. The only outstanding input is data, not judgement: real transcripts, the bridge limits schema (received), and control-frequency data.

---

## 9. What I'd want to know before the next round

Nothing in this file is a substitute for these, and their absence is what made me guess:

- **Real transcripts** — my fixtures are plausible, not real. Real ones would have told me the true distribution of turn lengths, tool-call density, and how often a turn is only a diff.
- **The bridge payload schema** for limits/status, so labels and units are derived rather than mapped.
- **Frequency data** on which controls you actually use — that is what should drive the order-of-sacrifice list above, rather than my inference.


---

## 10. Cross-cutting invariants (round 2)

These leaked last round: the pixels carried them, the documents didn't, so the implementation reproduced the layout and lost the rules. Stated here as rules, deliberately without pixel values where a value would hide the principle. Every surface — existing and future — must obey all six.

### 10.1 One content-width policy

There is exactly **one** content measure per region, and every child obeys it:

- Thread prose and every event card: **680px max**, left-aligned to the agent indent.
- Modal cards: **440px** (`min(440px, 94vw)`).
- Menus and popovers: sized to content, **212–300px**, never full-width.
- Own-message bubbles: `min(78%, 560px)`.

A card never sets its own width to fit its content, and never stretches to the pane. If something needs to be wider than its region's measure, it scrolls inside itself (code, diffs, thumbnail strips) — the measure does not bend.

### 10.2 The alignment grid — two left edges, one right edge

**At most two left edges exist inside any card.**

1. **Outer edge** = the card's `padding-left`. Every *direct child* starts here: the section label, body text, the action row, the resolved-state line. No exceptions, no optical nudges.
2. **Inner edge** = outer + 24px. This is the text column of a fixed 24px icon gutter. Every icon-prefixed line shares it, and so does any list that hangs off such a line.

A third edge is a bug. In practice that means: **an icon never displaces the text it labels into a new position** — it occupies the gutter, and the text lands on the inner edge whether the icon is present or not. Inline emoji are prohibited precisely because they *do* displace text: they make the left edge a function of glyph width, so no two rows line up. Icons are SVG in the gutter.

**One right edge:** timestamps, counts, and sizes align to the card's `padding-right`, and that same right edge is shared across every message type in the thread — an event card's timestamp, a bubble's timestamp, and a tool card's duration all land on one vertical line. A timestamp is never centred in its row and never floats after the text.

### 10.3 Section-spacing rhythm

Within a container, the gap between stacked elements is **constant** — one value per container, set once on the flex/grid `gap`, never as per-child margins:

| Container | Gap |
|---|---|
| Card internals (label / body / actions) | 10px |
| Modal body sections | 14px |
| Agent-turn elements | 8px |
| Sidebar rows | 1px |
| Field and its own label | 6px |
| Button groups | 8px |

Consequences: a label belongs to the field **below** it and is bound to it by the small gap — the ambiguity in the live new-session sheet (a label sitting between two fields, closer to the wrong one) is a rhythm failure, not a copy problem. And a card must not change its internal rhythm between states: the un-answered and answered prompt card keep the same three rows in the same order at the same gap, so resolving it doesn't reflow the thread.

### 10.4 Both-theme parity includes native chrome

A theme is not done when the custom elements are themed. Every one of these must be explicitly styled in **both** themes:

- **Scrollbars** — `scrollbar-color` plus `::-webkit-scrollbar-*`, from `--m-scrollbar` / `--m-scrollbar-hover`. A default light scrollbar across a dark modal is the single most visible parity failure.
- **Focus rings** — `2px solid var(--m-accent)`, offset 2px (inset −2px inside menus). **Never browser-blue.** A global `:focus-visible` rule is the floor, not a per-component opt-in.
- **Text selection** — `::selection` from `--m-selection`.
- **Native inputs** — every `input`/`textarea`/`select` sets `background`, `color`, and `border` explicitly. An unstyled input inherits the *UA* white, not the theme: that is the white-on-dark "Agent default" field. Placeholder colour is set too.
- **Disabled fields** — `--m-subtle` fill with `--m-ink3` text, never opacity alone (opacity on a UA-white field is still white).
- **Empty states** — every list has designed copy; never an empty box.
- **Theme-dependent assets** — any icon or image that assumes a background must have both variants or be `currentColor`.

### 10.5 One primary per surface

Exactly one filled accent button per surface, on the affirmative action: **Send now**, **Start session**, **Send**, **Allow**. Everything alongside it is secondary (outlined) or ghost. Two equal-weight outlined buttons — as in the live prompt card, where *Cancel* and *Send now* are indistinguishable — means the surface has no primary and the operator has to read to find the safe path.

Destructive actions are ghost, and reveal critical colour on hover only.

### 10.6 Menus: one component, many anchors

The conversation-actions menu is a single component. Only its anchor changes: **sidebar row → right-click (context menu only)**, **header → the ⋯ button**. Per the operator's call, sidebar rows carry **no persistent ⋯ affordance** — right-click is the only path there, which keeps the row's fixed columns (status glyph, name, time, badge) intact at every width.

Menu internals: rows are `grid 16px 1fr` with a 10px gap inside a 4px-padded shell, and row radius is smaller than shell radius so the hover fill **insets** from the shell edge instead of touching it. Groups are separated by a hairline, not by a gap.

### The hard states every surface must render

Non-negotiable; each has a static file:

| Surface | States |
|---|---|
| Prompt / Question card | un-answered · answered (+ queued list) · expired · read-only · both themes |
| New session sheet | default · path typed · checkbox on · disabled workspace field · both themes |
| Actions menu | rest · hover · keyboard-focused · destructive hover · both themes |
| Upload modal | single file · multi-file (`n of N` + strip) · last file · caption filled · both themes |
