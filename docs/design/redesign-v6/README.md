# redesign-v6: Under the hood · browser tools · one-tap New session

Drop-in for `docs/design/redesign-v6/`, next to `redesign-v5/`. (This design project can only write under `templates/`, so the folder lives at `templates/redesign-v6/` here. Move it as-is.)

> **In this repo copy:** the standalone HTML bundle, the 88 `static/*.html` exports, `census.json` and `tools/export.js` were not part of the handoff that reached the repo; only `static/index.json` is. Serve `Matron Redesign v6.html` (it loads `src/*`) and run `tools/probe.js` on it when you need exact values.

## Start here, in this order

0. **`HANDOFF.md`**: the single entry point for a coding agent. It has the condensed brief, every decision made, exact copy strings, bridge contracts, open decisions, known gaps, upstream design-system issues and the implementation order.
1. **`CHANGELOG-vs-current.md`** opens with *unchanged when Show the work is on*, then lists every change and the token mapping table (new → real `--cpd-*`, or genuinely new).
2. **`Matron Redesign v6 (standalone).html`**: the whole design as one offline file you can click through. The dashed **states** button (bottom right) reaches all 44 states, in either theme. `Matron Redesign v6.html` is the same thing unbundled (`src/model.js`, `src/render.js`, `src/app.css`, `src/app.js`).
3. **`static/index.json` → `static/*.html`**: 88 runtime-free state files (44 states × light/dark, including the 420px narrow pane and a 390px phone). Styles are inlined and fonts self-hosted, so `getComputedStyle` resolves natively. Hover/focus states are their own files.
4. **`design-tokens.json` / `.css`**, parsed from `src/app.css` by `tools/export.js`. They cover colour roles per theme, the written-out surface ladder, type roles with intent, spacing, radii, shadows, layering, motion (with choreography) and breakpoints (measured on the chat pane).
5. **`component-map.json`**: `data-spec` → selector. Each entry has `status` (implemented/new) and `visual` (aligned/divergent/unverified) as separate fields, plus compare-props and tolerance. Unread selectors are `new` with a `suggested` name.
6. **`GENERATIVE-SYSTEM.md`**: the grouping algorithm and sentence templates, live-line rules, order of sacrifice, content ranges, a11y, choreography, parameter spaces, the break-through derivation rule, what I rejected, and where I guessed.
7. **`CONTRACTS.md`**: fixtures, mocks, contracts (bridge `/restart --browser`, first task = first message), open decisions, and the **do-not-implement** list.
8. **`tools/probe.js`**: reads `[data-spec]` on design files, or the map's selectors on the live app (`window.MAP = …`). Set `PROBE_CENSUS = true` to add a value census. **`census.json`** is the measured census and contrast report for this round.

## Regenerating

Edit `src/*`, then run `tools/export.js`. It rewrites `static/`, both token files and `census.json` from the same renderer the artifact uses, so no values are hand-typed. Then re-bundle the standalone HTML.

## The six things to get right

1. The card's summary is **one row in every state** (done, running, slow, waiting, stopped), so a turn finishing never moves the thread.
2. Grouping follows the **agent's narration order**. It is not a global sort.
3. **Monospace and exit codes appear only in deep detail.**
4. Break-throughs sit **after** the card and never inside it.
5. Show the work ON **equals today**.
6. Breakpoints measure the **chat pane**, not the viewport.
