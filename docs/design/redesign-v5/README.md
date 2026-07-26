# redesign-v5 — Matron UI design package

Drop-in for `docs/design/redesign-v5/`. Every file is under 256 KiB, so it also survives a per-file MCP pull.

## Start here, in this order

1. **`CHANGELOG-vs-current.md`** — read at `origin/main` tree `eb6e7d6f3c4b`. Leads with what has ALREADY landed (do not redo), then the real divergences.
2. **`component-map.json`** — `data-spec` → `src/journal` selector, each marked `implemented` / `new` / `devtool`.
3. **`static/index.json`** → **`static/*.html`** — 20 runtime-free states. Measure these; do not eyeball screenshots.
4. **`design-tokens.json`** / **`.css`** — tokens, 27 type roles, states, breakpoints, layering, content-type specs, exact copy strings, usage relabel map.
5. **`GENERATIVE-SYSTEM.md`** — the rules behind the values: order of sacrifice as the pane narrows, assumed content ranges + overflow behaviour per element, accessibility intent, transition choreography, each component's full parameter space, derivation rules for extending the system, deliberate anti-goals, and where I was genuinely uncertain. **Read this before building any screen the mock doesn't show.**
6. **`tools/probe.js`** — dumps computed values for every tagged specimen (design side) or every mapped selector (live side). Feed both into your auto-diff.

`Matron Redesign.dc.html` (+ `support.js`, `res/`) is the interactive source of truth if you need to click through something the static files don't cover. `DESIGN-SPEC.md` is the narrative; `HANDOFF-PLAYBOOK.md` is the general contract for future design rounds.

## `static/` is self-contained

Every asset the state files reference lives under `static/` — `fonts/` (Inter + Fira Code, OFL) and `res/matron-logo-simple.svg` (brand mark, referenced 3× per file). Open any state file straight from disk and it renders complete, offline, with no CDN and no missing images. `static/index.json → assets` lists them; keep it that way if you regenerate.

## Probing

```js
const state = document.querySelector('meta[name=matron-state]').content;
[...document.querySelectorAll('[data-spec]')].map(el => {
  const cs = getComputedStyle(el);
  return { name: el.dataset.spec, target: el.dataset.target, font: cs.font,
    color: cs.color, background: cs.backgroundColor, border: cs.border,
    radius: cs.borderRadius, padding: cs.padding,
    hover: el.dataset.styleHover, focus: el.dataset.styleFocus };
});
```

`data-style-hover|active|focus` carry designed pseudo-state declarations as CSS text — a static file can't be hovered, so they are exposed as data instead.

## Two axes of status in `component-map.json`

`status` answers *does the code exist* (`implemented` / `new` / `devtool`). `visual` answers *does it match the design* (`aligned` / `divergent` / `unverified`). They are independent: **6 entries are implemented-but-divergent** — e.g. `sidebar.newSession` (a bare pencil icon where the design has a full teal button) — which neither the changelog's "do not redo" list nor its divergence list would have caught. **24 are `unverified`**: not determinable from reading source, deliberately left for the auto-diff rather than guessed at.

## Confirmed decisions

- **Agent turns are flat prose**, operator turns are teal bubbles. The live app already does this — no work.
- **The fable bar is omitted until the bridge sends that limit.** Never render an empty track. Labels are fixed short strings (`ctx` / `fbl` / `5h` / `wk`) via the client-side relabel map in `design-tokens.json → components.usageMeter.labelMap`, because the bridge's long labels truncate in a 24px column.
- Usage thresholds `<50` / `50–84` / `≥85` are already shipped in `status.ts` — unchanged.

## Do NOT implement

`data-spec="devtool.stateMatrix"` (the dashed **states** button in the mock's sidebar footer) and `data-spec="gallery"` (the state-matrix surface). Both exist only to make states probeable.

## Still open

**Nothing on the design side.** All five §8 uncertainties are resolved (flat %-based thresholds across all meters, 2×2 grid, pins-at-top then running-first, keep both subagent surfaces, mic stays right of the textarea). The fable limit's semantics and its bridge wiring remain product/plumbing work; the design renders correctly with or without it.

Outstanding input is data, not judgement: real (or redacted) transcripts, and control-frequency data — the latter would replace my inferred order-of-sacrifice in `GENERATIVE-SYSTEM.md` §1 with fact.

---

## Round 2 — four surfaces (2026-07-26)

Prompt/Question card, new-session sheet, conversation-actions menu, and the upload modal, all derived from the existing patterns rather than newly invented.

**Read `GENERATIVE-SYSTEM.md` §10 first.** It states the six cross-cutting invariants these surfaces obey — content-width policy, the two-left-edges/one-right-edge alignment grid, section-spacing rhythm, both-theme parity *including native chrome*, one-primary-per-surface, and the menu component/anchor rule. That section is the part that leaked last round: the mock carried the rules, the documents didn't, so the implementation reproduced the layout and lost the reasoning.

New static states: `light|dark-new-session`, `light|dark-new-session-filled`, `light|dark-actions-menu`, `light|dark-round2` (all four surfaces on one grid, prompt card in both states, upload single-vs-multi side by side). 28 states total.

### What the live screenshots showed, and the rule behind each fix

| Observed | Rule it breaks |
|---|---|
| Prompt card: *Cancel* and *Send now* both outlined | §10.5 — one primary per surface. Send now is the only filled button. |
| Prompt card: inline emoji (📨 ⚡ ✓) prefixing body lines | §10.2 — glyph width makes the left edge variable, so no two rows align. SVG in a fixed 24px gutter instead. |
| Prompt card: timestamp floating bottom-right below the content | §10.2 — one shared right edge, on the label row, same line every message type uses. |
| New session: title right-aligned, "Close" as a text link | §10.2/§10.3 — upload-dialog shell: left title + icon, X close, header rule. |
| New session: workspace field sitting above the "Folder path" label | §10.3 — a label binds to the field *below* it at the small gap. Each field gets its own label. |
| New session: "Agent default" input white-on-dark | §10.4 — an unstyled native input inherits *UA* white, not the theme. Background, colour and border are all set explicitly; disabled uses `--m-subtle`/`--m-ink3`, never opacity alone. |
| Actions menu: browser-blue focus ring | §10.4 — focus is always `2px solid var(--m-accent)`, and a global `:focus-visible` rule is the floor. |
| Actions menu: full-width rows touching the shell edge, gaps between them, no separator before Archive | §10.6 — 4px-padded shell, row radius < shell radius so hover insets, hairline groups. |
| Upload modal: raw filename as the modal title, no file-info row / strip / counter | §10.1/§10.2 — title is always `Send file`; the filename lives in the file-info row under the preview. |
| Unstyled horizontal scrollbar crossing a dark modal | §10.4 — scrollbars are themed via `--m-scrollbar` / `--m-scrollbar-hover`. |

**Sidebar ⋯ removed** per the operator's call: sidebar rows are right-click only, so the row keeps its fixed columns (status glyph, name, time, badge) at every width. The header ⋯ is the only persistent trigger, and both anchors mount the same menu component.

Three new tokens: `--m-scrollbar`, `--m-scrollbar-hover`, `--m-selection`.

### Publishing

No DesignSync tool is exposed in this canvas session, so the package ships as the zip in chat (and as `redesign-v5/` in the project). `from-coding-agent/` is created and ignored on my side — drop auto-diff output there and I'll read it next round. If you'd rather I publish directly, wire the connector and I'll push instead of exporting.
