# HANDOFF: Matron web client, design round v6

**Read this file first.** It is the single entry point for a coding agent implementing v6 in `easelyte/matron-web`. It holds the brief, every decision already made, the open decisions and the implementation order. The other files go deeper, and this file says which one to open for what.

- Package location in this design project: `templates/redesign-v6/`. The design tool only writes under `templates/`. In the repo it belongs at **`docs/design/redesign-v6/`**, next to `redesign-v5/`. Move the folder unchanged; all paths inside are relative.
- Baseline read: `easelyte/matron-web@main`, tree `2a1b2bad2046`, 2026-09-26. Sources read: `src/journal/shell.pcss`, the journal.pcss build (`_ds_bundle.css` of matron-web@1.12.11-rc.0), `docs/design/redesign-v5/{GENERATIVE-SYSTEM,README,CHANGELOG-vs-current}.md`, `docs/design/redesign-v5/tools/probe.js`. `components.tsx` and `types.ts` were grepped (event types, `tool_output` / `diff` payload fields), not read end to end.
- Stack: React 19 + PostCSS, no Tailwind. Styles go in `src/journal/journal.pcss` and `src/journal/shell.pcss`. Tokens are the live `--cpd-*` set in `shell.pcss`.

---

## 1. The brief, condensed

**North star.** The thread should read like a regular Claude or ChatGPT chat: easy for a non-developer, never messy. Today every tool call, command and diff is its own card (about 5 per typical turn, 31 on a busy one, 210 at worst). All of that stays, but it moves inside **one "Under the hood" card per operator turn, collapsed by default**. The thread reads as: my message, a quiet card, the agent's answer.

**Binding invariants** (redesign-v5 GENERATIVE-SYSTEM §10, all still apply):
- one content width
- two left edges and one right edge per card (24px icon gutter)
- a constant gap per container
- both-theme parity, including native chrome (scrollbars, focus ring, selection, native inputs, disabled fields)
- one primary per surface
- one menu component with many anchors
- the card owns its chrome and the payload supplies only content

**Three surfaces:**
- **A.** The thread and the "Under the hood" card, plus the "Show the work" setting.
- **B.** "Enable browser tools" in the session menu.
- **C.** One-tap New session: a split button plus an options sheet.

---

## 2. What to open for what

| Need | File |
|---|---|
| Click through every state (offline) | `Matron Redesign v6 (standalone).html` (dashed **states** button, bottom right) |
| Readable source of the design (reference implementation of grouping + rendering) | `src/model.js` (fixtures + grouping algorithm), `src/render.js` (state → HTML), `src/app.css` (all styles + tokens), `src/app.js` (interaction only) |
| Exact computed values per state | `static/index.json` → `static/{light,dark}-*.html` (88 files) |
| Tokens (per theme, type roles, motion, breakpoints, layering, surface ladder) | `design-tokens.json`, `design-tokens.css` |
| Which selector each design element maps to, and whether it exists | `component-map.json` |
| Rules behind the pixels (grouping, live line, degradation, ranges, a11y, motion, parameter spaces) | `GENERATIVE-SYSTEM.md` |
| What changes vs today, token mapping table | `CHANGELOG-vs-current.md` |
| Fixtures, contracts with the bridge, mocks, do-not-implement | `CONTRACTS.md` |
| Measured value census + contrast report | `census.json` |
| Auto-diff tooling | `tools/probe.js` (design or live), `tools/export.js` (regenerates statics/tokens/census) |

---

## 3. Implementation order (suggested), with acceptance criteria

1. **Setting plumbing.** Add a per-operator preference `showTheWork` (default `false`, suggested localStorage key `matron.showTheWork`).
   - *Done when* ON renders the thread exactly as today (`static/*-thread-on.html`).
2. **Grouping module** (pure, unit-tested). Port `src/model.js → CLASSES, groupTurn, stepSentence, liveLine, changedFiles` to TypeScript beside the timeline code. Input is the journal events of one turn.
   - *Done when* the fixtures in `src/model.js` reproduce the sentences in §5 below (turn 1 → "Looked through 3 files", "Searched the code 2×", "Checked the history", "Changed 1 file", "Ran the tests: passed", "Checked the types: failed once, then passed").
3. **`.mj_TurnCard`**: collapsed row, running/slow/waiting/stopped/done modes, expanded body, groups, steps, deep detail (reusing `.mj_DiffCard` / `details.mj_ToolCard` markup).
   - *Done when* `tools/probe.js` against the live app matches `static/*-card-*.html` within the tolerances in `component-map.json`.
4. **Thread assembly** when OFF:
   - operator bubble → agent tile: card (only if the turn has ≥1 step) → break-throughs in order → `.mj_TurnError` if the turn ended in error → answer prose
   - bridge notices become `.mj_SystemNotice`
   - hide `.mj_Activity` in this mode
5. **Settings menu**: identity block, Show the work switch row with its hint, hairline, Sign out. **Remove "Edit a file".**
6. **Session menu item + confirm dialog + header chip** for browser tools, driven by bridge events.
7. **Split New session button + options sheet.**
8. **Pane breakpoints**: a ResizeObserver on the chat pane sets `data-pane` = `narrow` (≤480) · `medium` (≤760) · `wide`.
9. **Auto-diff**: run `tools/probe.js` on every `static/*.html` and on the live app with `window.MAP = component-map.json`. Drop the results in `redesign-v6/from-coding-agent/`.

---

## 4. Decisions already made (do not re-decide)

**Card**
- The collapsed summary is **one row in every state** (done / running / slow / waiting / stopped). The live line occupies the same slot as "N steps · duration", so finishing a turn never changes the card's height. A two-line variant was rejected because it jumps on resolve.
- Row layout: `16px glyph · "Under the hood" · meta · (Stop) · chevron`, min-height 36, padding 9/12, the same rhythm as the `.mj_ToolCard` summary. Title row is `--cpd-color-bg-canvas-raised`; the expanded body is `--cpd-color-bg-canvas-default`.
- Glyph:
  - `.mj_LiveDot` pulse while working
  - check (secondary ink) when done cleanly
  - **amber dot (`--mj-warn-dot`) when done but any step failed along the way**. So turn 1 shows the amber dot, because its type check failed once.
  - a static accent dot while waiting
- Meta, done: `· {n} steps · {duration}`. n counts steps only, never narration. Turn 1 = **11 steps · 3m 12s** (the count comes from the fixture, not the brief's example "14").
- Running: `· {live line}` plus ` · 42s` once the current step passes 10s.
- Slow (step ≥ 5 min): the line turns `--mj-warn-ink` and a "Stop" text button appears. Stop ends the turn as `Stopped · N steps` with the amber dot.
- Waiting: "Waiting for you" in accent ink, no animation.
- Expanded order: **Changed files** block (first 5 + "Show all N files"), then groups interleaved with narration **in the order they happened**. Groups show step lists capped at 12 + "Show all {k}", and must virtualize past about 200 rows.
- Group row: icon · sentence (+ ": outcome") · status glyph · `{k} steps` · chevron. Recovered outcome text is amber and never red. Red is only for a group whose last step failed.
- Deep detail opens **in place** under the row that opened it, with "Back to steps" / "Back to files". **Monospace and exit codes exist only at this level.** A failed command shows its passing rerun directly below it.
- Motion: no height animation anywhere. Chevron rotation 120ms, body/deep fade-in (120/180ms), live-line cross-fade 240ms at most once per 1.2s, and a 180ms resolve fade from running to done.

**Thread**
- Break-throughs render **after** the card, in the order they happened, with their existing full cards. They never go inside the card.
- A turn with 0 steps has **no card**; it looks exactly like a normal chat.
- Turn-ending error = `.mj_TurnError` (`role=alert`), a one-line critical row below the card.
- System notices = one tertiary meta line, no avatar (tertiary is below AA; this was the brief's explicit call).
- Show the work ON = today's rendering, unchanged.

**Wording**
- Never use the word "mode". Never use "Compact" (it already means context compaction).

**Browser tools**
- One primary: "Restart with browser tools". "Restart now" is secondary and appears **only** while the agent is mid-task. Cancel is ghost.
- States:
  - idle
  - confirm (idle agent / busy agent)
  - queued: header chip "Restarting after this step"
  - restarting: system notice "Restarting with browser tools…"
  - on: checked, disabled "Browser tools on"
  - Codex: disabled, hint "Not available for Codex sessions"

**New session**
- Split button at the same 34px, full width. The main segment starts immediately with the defaults and no sheet. ⋯ is a 34px square behind a hairline and opens the sheet.
- Defaults hint ("Opus · workspace") appears only when the defaults are known, and only when the split is ≥240px wide (container query). Below that width it is **hidden, never truncated**. Between 240 and 300px the pencil icon gives way to the hint. The mock's sidebar is 272px.
- Sheet fields, in this order:
  1. Folder: a radiogroup, newest first, the default tagged "default", plus "Other folder…"
  2. Agent: Claude | Codex segmented control, shown only if both are available
  3. Model: select, preselected to the box default; disabled with "Codex picks its own model" when Codex is chosen
  4. Browser tools: switch, off by default, with its hint; disabled for Codex
  5. First task (optional)
  6. "Remember as my defaults"
  7. Box: caption "On box-1", or a low-fi multi-box row labelled "multi-box: owned upstream"

**Other**
- Settings menu content: username + server · Show the work · hairline · Sign out.
- Breakpoints measure the **chat pane** (ResizeObserver), never the viewport. The existing phone layout (`@media ≤700px`) is unchanged.
- Order of sacrifice at narrow:
  - card row: total duration → step count → live line truncates. Glyph, title, chevron and Stop are never dropped.
  - group rows: count column → indent 24→12 → sentence wraps.
  - deep panel: pulls out to the card's outer edge.

---

## 5. Exact copy strings

- Card: `Under the hood` · `{n} steps` / `1 step` · `Waiting for you` · `Stop` · `Stopped` · `Changed files` · `Show all {n} files` · `Show all {k}` · `Back to steps` · `Back to files` · `Load full output` · `Open helper`
- Group sentences and step sentences: the template table in `GENERATIVE-SYSTEM.md §1`. Outcomes: `passed`, `failed`, `failed once, then passed`, `failed {n}×, then passed`.
- Live lines (examples, template-driven): `Reading {file}…` · `Searching for {pattern}…` · `Running the tests…` · `Checking the types…` · `Asking a helper to {description}…`
- Turn error (fixture): `The session couldn’t resume. Send a message to start fresh.`
- Notices (from the bridge, not the design): `Compacted, context now 3.7k/1m` · `Session was idle, resuming` · `Sending 1 queued message` · `Restarting with browser tools…`
- Settings: `Show the work` + hint `Show every step in the chat instead of tucking it under the hood` · `Sign out`
- Session menu: `Enable browser tools` + hint `Lets the agent take screenshots and use web pages · restarts the session, keeps the conversation` · `Browser tools on` · `Not available for Codex sessions` · `Restarting after this step` · `Restarting…`
- Confirm dialog:
  - title `Enable browser tools`
  - body `Matron restarts this session with browser tools, so the agent can take screenshots and use web pages.` · `The conversation is kept.` · `Browser tools use about 400 MB of memory while on.`
  - busy block `The agent is in the middle of a task. The restart waits until it finishes. Restart now stops the current step instead.`
  - buttons `Cancel` · `Restart now` · `Restart with browser tools`
- Header chip: `Restarting after this step`
- Split button: `New session` · `Starting…` · `Couldn’t reach the box. Retry · Options` · `May have started. Check your list` · `No box connected`
  - accessible names: `Start a new session: {hint}` / `Start a new session` / `Starting a new session` / `New session options`
- Sheet: `New session` · `Folder` · `default` · `Other folder…` · `That folder doesn’t exist on the box.` · `Agent` · `Claude` · `Codex` · `Model` · `(box default)` · `Codex picks its own model` · `Browser tools` · `You can also turn this on later from the session menu · ≈400 MB while on` · `First task (optional)` · placeholder `What should it start on?` · `Remember as my defaults` · `On {box}` · `Cancel` · `Start session`

---

## 6. Contracts with the bridge / client

1. The live line and step sentences come from **client templates** plus the agent's own narration, never from the design.
2. The grouping rules (`GENERATIVE-SYSTEM.md §1`) are a proposal. `src/model.js` is the reference implementation.
3. "Enable browser tools" sends **`/restart --browser`**. It keeps the conversation and waits for the current turn unless forced; "Restart now" is the forced variant. Queued/restarting/on must come from bridge events. The mock uses timers.
4. One-tap start uses the default folder, model and agent, with browser tools off. With "Remember as my defaults" on, it uses the operator's stored choices (client-side, per box), and the hint updates.
5. **First task is sent as the first ordinary message** after the session starts.
6. "That folder doesn't exist on the box." comes from the bridge's start error; there is no client-side path validation.
7. "May have started" is shown when the start RPC times out without a result. Never auto-retry.

---

## 7. Open decisions (need an answer; defaults in brackets)

1. **Accent text contrast in light.** `#0d9488` measures about 3.5–3.7:1 on light surfaces: links, +N counts, the New session label, "Waiting for you", "Show all". This is system-wide and already true today. [Proposal: use `--cpd-color-bg-accent` #0f766e, ≈5.4:1, for text in light.]
2. **Settings anchor.** Live `.mj_AccountMenu` is positioned `top:44px; right:8px`; the brief says the sidebar gear. [Mock: sidebar-footer gear.]
3. **Codex tool names in grouping** (`shell`, `apply_patch`, …). [Map `apply_patch` → change; classify `shell` by its command.]
4. **Changed-file deep view.** Last diff for the path, or all diffs for the path concatenated? [Last diff.]
5. **Turn duration start.** The operator message or the agent's first event? [The operator message.]
6. **Failed step deep view.** The next passing rerun only, or all later attempts? [The next passing one.]
7. **400 MB.** Fixed copy, or reported by the bridge per box? [Fixed until the bridge reports it.]

## 7a. Decisions (confirmed by the operator, 2026-09-25)

All seven open decisions above were confirmed as final, with the defaults as proposed. They are decided, not provisional.

1. **Accent text in light** uses `#0f766e` (`--cpd-color-bg-accent`, about 5.4:1). Accent icons and fills keep `#0d9488`.
2. **Settings anchor**: the Settings menu opens from the sidebar-footer gear.
3. **Codex tool names**: `apply_patch` (and the legacy `file_change` output) is a change step; `shell` is classified by its command, after unwrapping `bash -lc '…'`, a leading `cd … &&` and leading `VAR=value` assignments.
4. **Changed-file deep view** shows the last diff for the path.
5. **Turn duration** runs from the operator message to the turn's last event.
6. **Failed step deep view** shows the next passing rerun only.
7. **400 MB** is fixed copy until the bridge reports a per-box figure.

## 8. Known gaps / where the design guessed

- Today's rendering of bridge notices and turn-ending errors when Show the work is ON: drawn as agent text, marked `unverified`.
- The tracker item card (`tracker/cards.tsx`) was not read. The mock draws a stand-in, and the real `ItemCard` should render unchanged.
- The grouping regexes are based on fixtures, not real journals.
- **Inter 500:** the app's `fonts/fonts.css` ships only Inter 400/600, so 500 (labels, menu rows, the card title) is likely synthesised as 400 in live. The package ships InterVariable. Check this in the auto-diff and consider shipping Inter 500 or the variable font.

## 9. Upstream design-system check issues (fix in matron-web, then re-run `/design-sync`)

These are in the synced stylesheet, not in v6:
1. Add `/* @kind other */` after `--cpd-dur-fast`, `--cpd-dur-med` and `--cpd-ease` in `shell.pcss :root`.
2. Five custom properties are declared under component selectors: `--EventTile-bubble-max-width` on `.mx_EventTile[data-layout="bubble"]`, `--RoomView_MessageList-padding` on `.mx_RoomView_body[data-layout="bubble"]`, and others on `.mx_LeftPanel_outerWrapper`. They are component-local layout values, not theme tokens. Leave them, or promote them to `:root` as `--mj-*` if the check should stop flagging them.

## 10. New selectors and tokens (summary; full detail in `component-map.json` / `CHANGELOG-vs-current.md`)

- **New selectors (suggested names):**
  - card: `.mj_TurnCard` (+ `_row _toggle _glyph _title _meta _live _liveText _elapsed _stop _chevron _body _label _changed _file _counts _narration _group _groupRow _sentence _outcome _status _count _steps _step _stepNote _more _now _deep _deepHead _back _deepMeta _helper _helperOpen`)
  - thread: `.mj_TurnError`, `.mj_SystemNotice`
  - menus and header: `.mj_Switch`, `.mj_MenuHint`, `.mj_RoomItemMenu_item_switch`, `.mj_HeaderChip`, `.mj_SessionMenu`
  - New session: `.mj_NewSessionSplit` (+ `_main _more _sep _label _hint _note _disabled`)
  - sheet: `.mj_Field`, `.mj_FieldLabel`, `.mj_FieldHint`, `.mj_FieldError`, `.mj_FolderList`, `.mj_FolderOption`, `.mj_Radio`, `.mj_Tag`, `.mj_TextInput`, `.mj_Select`, `.mj_TextArea`, `.mj_Segmented`, `.mj_SwitchRow`, `.mj_CheckRow`, `.mj_BoxCaption`
- **Reused unchanged:** `.mx_EventTile[data-self]`, `.mj_LiveDot`, `.mj_Activity` (ON only), `details.mj_ToolCard`, `.mj_DiffCard`, `.mj_PromptCard(_permission)`, `.mj_SpawnOutcomeRow`, `.mj_PeerMessage`, `.mj_Image`, `.mj_File`, `.mj_HeaderMenu.mj_RoomItemMenu` + `.mj_RoomItemMenu_item`, `.mj_AccountMenu`, `.mj_UploadConfirm*`, `.mj_NewSessionSheet`, `.mj_NewSessionRow`/`.mj_NewSessionButton` (becomes the main segment), `.mj_Spinner`.
- **New tokens:**
  - colour: `--mj-warn-ink` (light #9a5700 / dark #ffb454), `--mj-warn-tint`
  - aliases of existing values: `--mj-warn-dot` → `--cpd-color-usage-medium`, `--mj-accent-border` (the live 25% teal literal), `--mj-font-label-sm` (the live 500 12/16 literal)
  - motion: `--mj-live-xfade` 240ms, `--mj-live-min-interval` 1200ms, `--mj-live-elapsed-after` 10s, `--mj-slow-after` 300s, `--mj-card-expand`/`--mj-group-expand` → `--cpd-dur-fast`, `--mj-deep-open`/`--mj-resolve` → `--cpd-dur-med`
  - breakpoints: `--mj-bp-pane-narrow` 480, `--mj-bp-pane-medium` 760, `--mj-bp-sidebar-min` 224
  - layering: `--mj-z-menu` 30, `--mj-z-modal` 50

## 11. Do not implement

- The dashed **states** devtool (`data-spec="devtool.stateMatrix"`, `.mv6-dev*`).
- The `.is-hover` / `.is-focus` forcing classes. Implement real `:hover` / `:focus-visible`.
- `.is-mid` (the frozen cross-fade used in one static).
- `.mv6-phone` / `.mv6-narrowStage` frames and `.mv6_*StandIn` placeholders.
- Hash routing (`#state=…&theme=…`).
- The timers that fake bridge events.
- `tools/*`, `census.json` (tooling only).
