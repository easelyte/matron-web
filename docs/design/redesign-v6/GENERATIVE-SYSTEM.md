# Generative system v6: the decisions the pixels don't carry

This is the reflection pass on round v6 ("Under the hood", browser tools, one-tap New session). `design-tokens.json` and `static/` record what the artifact is. This file records the rules I applied, so a coding agent can build screens I didn't draw. When this file and a measured value disagree, trust the artifact for values and this file for intent.

Every rule in v5 §10 still applies: one content width, two left edges and one right edge, section-spacing rhythm, both-theme parity including native chrome, one primary per surface, one menu component with many anchors, and "the card owns its chrome, the payload supplies content". Where v6 extends a v5 rule, the v5 section number is given.

---

## 1. The activity-grouping algorithm

Code: `src/model.js → groupTurn()`. It is the reference implementation; port it rather than re-deriving it.

**Input.** A turn is the ordered journal events between one operator message and the next. The card takes only **steps** (`tool_output`, `diff`, and the tool-use events that produce them) and **narration** (agent `text` that arrives *before* the turn's last step). Break-throughs (§6) never enter the card. Agent text *after* the last step is the answer and renders below the card as normal prose.

**Segmenting.** Narration closes the current segment and is emitted as connective text. Within a segment, steps merge **by activity class**, and groups are ordered by the **first occurrence** of their class. Steps never merge across narration, so the agent's own commentary stays between the right groups.

**Classes, first match wins** (`CLASSES` in model.js):

| class | matches | group sentence | step sentence | live line |
|---|---|---|---|---|
| look | Read, NotebookRead; Bash `cat / head / tail / sed -n / less / wc` | 1 distinct path: `Read {file}`; else `Looked through {n} files` (n = distinct paths) | `Read {file}` | `Reading {file}…` |
| search | Grep, Glob, Search; Bash `rg / grep / find / fd / ls` | `Searched the code` / `Searched the code {k}×` | `Searched for {pattern}` / `Looked for files named {glob}` | `Searching for {pattern}…` |
| change | Edit, MultiEdit, Write, NotebookEdit, `diff` events | `Changed {n} file(s)` (distinct paths) | `Changed {file}` / `Created {file}` | `Changing {file}…` |
| test | Bash matching `vitest / jest / pytest / playwright / go test / cargo test / (pnpm\|npm\|yarn) (run )test` | `Ran the tests: {outcome}` | `Ran the tests` | `Running the tests…` |
| check | Bash matching `tsc / typecheck / eslint / oxlint / mypy / ruff / lint` | `Checked the types: {outcome}` (`the code style` for lint) | `Checked the types` | `Checking the types…` |
| history | Bash `git log / show / blame / diff / status` | `Checked the history` / `… {k}×` | `Checked the history` | `Checking the history…` |
| git | Bash `git push / commit / switch / checkout / merge / rebase / pull / add` | k=1: the step sentence; else `Updated the branch {k}×` | `Pushed the branch` / `Saved a commit` / `Updated the branch` | `Updating the branch…` |
| helper | Task, Agent (spawn) | `Asked a helper: {description}` / `Asked {k} helpers` | `Asked a helper to {description}` | `Asking a helper to {description}…` |
| web | WebFetch, WebSearch, Browser | k=1: step sentence; else `Looked at {k} web pages` | `Took a screenshot of {host}` / `Opened {host}` | `Looking at a web page…` |
| run | any other Bash | `Ran a command` / `Ran {k} commands` | `Ran a command` | `Working…` |
| other | anything else, including unknown tools | `Did {k} other steps` | `Did a step` | `Working…` |

**Repeats.** A step whose sentence equals the previous step's sentence in the same group gets `again` appended ("Checked the types again"). That is the only de-duplication. Two reads of the same file stay as two rows, because the operator may want either.

**Outcome and "failed, then fixed" detection.** For each group, look at every step's status and at the last step:
- no failures → `ok` → test/check append `: passed`
- ≥1 failure and the **last** step in the group succeeded → `recovered` → `: failed once, then passed` / `: failed {n}×, then passed`, amber
- last step failed → `failed` → `: failed`, critical
- last step running → `running` → the sentence becomes the live line without its ellipsis

"Fixed" is judged per group, not per command, because an agent often edits files between the failure and the rerun, and the rerun can be a narrower command. Other classes don't append outcome text. If they recover, the status glyph turns amber and the row reads "one step failed, then worked" for screen readers.

**Counts.** A group row shows `{k} steps`, right-aligned in `--cpd-font-meta` (§10.2 right edge). The sentence counts distinct objects ("3 files"). The count column counts actions (4 steps). The two numbers answer different questions, and both are kept on purpose.

**Changed-files block.** Sum `added` and `removed` per path across all change steps. Show the first 5 rows, then `Show all {n} files`. A row's deep detail is the **last** diff for that path (the design shows one step; a coding agent could concatenate diffs, and I left that open).

**Collapsed meta.** `{n} steps · {duration}`, where n counts steps and ignores narration. Duration runs from the operator message to the last event of the turn.

**Where I'm guessing:** the regexes come from reading my own fixtures, not the bridge's real tool names across Claude *and* Codex. Codex tool names (`shell`, `apply_patch`, …) need rows in this table. `apply_patch` → change, and `shell` is re-classified by its command.

## 2. The live line

- **Source.** The present-progressive template for the *currently running* step (table above). If the agent has emitted narration more recently than the step started, the narration's first sentence wins, trimmed to 90 chars. Design never supplies these strings.
- **Cadence.** The line changes at most once per `--mj-live-min-interval` (1.2s). While a change is queued, a newer text replaces it: the line skips stale states and never plays a backlog.
- **Cross-fade.** Outgoing and incoming spans sit in one grid cell, with opacity only, `--mj-live-xfade` 240ms. The row never changes height.
- **Elapsed.** Once the current step passes `--mj-live-elapsed-after` (10s), ` · 42s` appears in secondary ink with tabular numerals. From 60s it reads `1m 04s`.
- **Slow.** At `--mj-slow-after` (300s) the meta turns `--mj-warn-ink` and a `Stop` text button appears before the chevron. Stop interrupts the step and ends the turn as `Stopped · N steps`, with the amber dot.
- **Waiting.** When the turn is blocked on a permission request or question, the meta reads `Waiting for you` in accent ink. The accent dot is static because nothing is working.
- **Announcements.** `role="status"`, `aria-live="polite"`, `aria-atomic="true"`. A hidden prefix carries state ("Working: Running the tests…", "Done, 11 steps"). Screen readers therefore get at most one announcement per 1.2s, and the elapsed counter is excluded (it updates as text inside a node, but a screen-reader implementation should put the elapsed time in a separate `aria-hidden` span; see the do-not list).

## 3. Order of sacrifice (pressure)

Measured element: **the chat pane** via ResizeObserver → `data-pane` = `narrow` (≤480) · `medium` (≤760) · `wide`. The viewport is never used here. The phone layout (@media ≤700px) is unchanged.

**Card title row**, first to go → never:
1. total duration (`· 3m 12s`)
2. the step count in the stopped state (the done-state count is the label and stays)
3. the live line truncates with an ellipsis (a 90-char live line clips on one line)
4. **never**: glyph, the done-state step count, chevron, and `Stop` when it is shown (the "Under the hood" title was removed 2026-09-26, HANDOFF §7a)

**Group rows:**
1. the `{k} steps` count column (hidden at narrow)
2. the step-list indent shrinks from 24px to 12px, and narration follows it
3. the sentence wraps (never ellipsed; it is prose)
4. **never**: icon gutter, status glyph, chevron

**Deep detail:** the panel pulls out to the card's outer edge (the indent is dropped) at narrow. Code and diff bodies scroll horizontally and never wrap diff lines. Tool output does wrap (`pre-wrap`, as live does). The Back control and exit badge never go.

**Split button** at a 224px sidebar:
1. the defaults hint drops entirely below a 240px split width (container query), rather than showing "Opus · wo…"
2. between 240 and 300px the pencil icon yields to the hint
3. **never**: the label "New session", the 34px ⋯ segment, the hairline
- Phone: both segments grow to 44px tall, and ⋯ grows to 44 wide.

## 4. Content ranges I assumed

| Element | Drawn for | Outside the range |
|---|---|---|
| Steps in a turn | 0, 5, 11, 210 | **0 → no card at all** (turn 6). 1 → card still renders (one group). >500 → still groups, and the lists inside groups cap at 12 rows + `Show all {k}`. Rows past 200 inside an opened group must virtualize. |
| Groups per turn | 1–9 | Unbounded in theory, but narration usually caps a segment at ~4 groups. No cap on groups. |
| Live line | ≤ 90 chars | One line with an ellipsis. Never two lines. |
| Path in a step | ≤ 400 chars | Sentences use the **basename** only. The full path goes in the `title` and in the deep detail, where it wraps (`overflow-wrap:anywhere`). |
| File name with no extension | — | Generic file icon. Never derive the icon from the extension. |
| Changed files | 1–12 | First 5 + `Show all`. |
| Narration | 1 sentence | Full text, wraps, never clamped. It is the agent's voice. |
| Recent folders | 12 | The list scrolls at ~6 rows. The longest path ellipses at the end, with the full path in `title`. Beyond 12, the client keeps the newest 12. |
| Duration | 0s–48m | `Ns` · `Nm SSs` · `Nh MMm`. |
| Helpers per turn | 0–2 | Each helper is its own step in one group, and each emits its own "helper started" break-through row. |

## 5. Accessibility intent

- **Card toggle:** `<button aria-expanded aria-controls>`. Enter/Space toggles. Focus stays on the toggle.
- **Group row:** the same pattern. Collapsing a group whose step list holds focus returns focus to the group row.
- **Deep detail:** opened from a step or file row (`aria-expanded` on that row). **Back** and **Escape** close it, and focus returns to the row that opened it. Escape unwinds one layer per press, outermost first: modal → menu → deep detail. It never collapses the whole card.
- **Stop:** a separate button, never nested inside the toggle. Its accessible name is "Stop".
- **Split button:** a `role=group` labelled "New session". Main: `Start a new session: Opus · workspace` (or `Start a new session` when defaults are unknown, `Starting a new session` while busy). More: `New session options`, `aria-haspopup=dialog`. When the sheet closes, focus returns to ⋯. After Start, focus goes to the main segment (which is then showing "Starting…").
- **Menus:** `role=menu`. Show the work is `menuitemcheckbox`. Browser tools on is a checked `menuitemcheckbox`, `aria-disabled`. Disabled items keep their hint visible, because the hint is the reason.
- **Confirm dialog:** focus lands on the primary. Escape and Cancel return focus to the header ⋯.
- **Options sheet:** focus lands on the selected folder. The bad-folder error is `role=alert`, tied to the input by `aria-describedby`, and focus moves to the input.
- **Turn error row:** `role=alert`. A permission request stays the only other assertive element (v5 §3).
- **Contrast:** the census (`census.json → contrastBelowAA`) finds the new pieces clean except **accent text**: `#0d9488` measures 3.5–3.7:1 on the light surfaces. This is a system-wide issue that already exists (links, +N counts, the New session label, "Waiting for you"). **Open decision:** use `--cpd-color-bg-accent` (#0f766e, ≈5.4:1) as text accent in light. Tertiary timestamps and the system-notice line are below AA by the brief's explicit instruction ("quiet tertiary line").

## 6. Break-throughs, and the rule for a new type

Break-throughs render **after the card, in the order they happened, with their existing full card**, and never inside it. The current list: permission requests (including agent_spawn consent), questions (including queued-message cards), tracker items / milestones / missions, images and files the agent sends, peer messages, "helper started" rows, turn-ending errors.

**Derivation rule for a new event type.** Ask: *would the operator want to see this if they never opened the card?*
- If it asks the operator for something (answer, approve, open), carries an artefact the operator will use (a file, image or link), comes from outside this agent (a peer, the tracker), or ends the turn, it is a **break-through**.
- If it is the agent's own work toward the answer (reading, searching, running, changing), it is a **step**.
- If it is the bridge talking about the session (compaction, idle/resume, queued sends, restarts), it is a **system notice**: one tertiary line with no avatar, whether or not the card is shown.
- If you can't decide, make it a step. It is always recoverable one tap down, while a wrong break-through is noise.

## 7. Transition choreography

| Moment | Animates | Deliberately doesn't |
|---|---|---|
| Live line changes | opacity cross-fade, 240ms | width of the card, row height |
| Card expand | chevron rotation 120ms; body fades in 120ms | **height** (v5 §4: animating height makes the thread jump under the reader) |
| Group expand | chevron 120ms | the list (appears at once) |
| Deep open | panel fades in 180ms | close is instant |
| Turn finishes | glyph (dot → check/amber dot) and meta (live line → "N steps · 3m 12s") fade 180ms in the same box | card size, the answer's arrival (it streams as prose, as today), card collapse state (if the operator opened it, it stays open) |
| New step while expanded | nothing: the row appends | no highlight flash, no auto-scroll inside the card |
| Show the work toggled | instant re-render, scroll anchored to the operator message nearest the top | no transition between the two renderings |

## 8. Component parameter space

**TurnCard** `{ mode: done | running | slow | waiting | stopped, open: bool, issues: bool, steps: n, durationMs, live: { text, elapsed }, groups: Group[], changedFiles: File[], deep: { stepId, from: files | group } | null }`
- `issues` only changes the done glyph (check → amber dot). It never tints the card.
- `waiting` beats `slow` beats `running` for the meta. A slow step that becomes blocked on a permission request reads "Waiting for you".
- A `running` card may be `open`, in which case a final "now" row shows the live line inside the body too (so the card body reads as a complete log).
- Legal but undrawn: `stopped` + open. It looks like done-with-issues, with the running group reading "Stopped".

**Group** `{ key, icon, sentence, outcomeText, status: ok | recovered | failed | running, steps: Step[], open, showAll }`

**Step** `{ tool, input, status: ok | failed | running, exit?, ms, output?, fullBytes?, diff?, added?, removed?, helper? }` → deep kind: change → diff · helper → helper · everything else → command (a failed step also shows its passing rerun, meaning the next ok step in the group with the same command).

**Split button** `{ state: idle | starting | error | uncertain | nobox, hint: string | null, forced: hover/focus per segment }`. `error` and `uncertain` add one line under the button, and the button stays enabled. `nobox` disables both segments and shows a neutral fill.

**Options sheet** `{ folders: string[≤12], defaultFolder, folder: i | 'other', other, folderError, agentsAvailable: ['claude','codex'], agent, models, model, browser, task, remember, boxes }`. Codex disables the model select (note "Codex picks its own model") and browser tools (hint "Not available for Codex sessions"). Remember writes `{ folder, model, agent }` to the one-tap defaults, and the split hint updates at once.

**Browser tools item** `{ session: claude | codex, state: idle | queued | restarting | on }` → five renderings (§ component-map).

## 9. What I rejected

- **A progress bar or step counter that ticks up in the collapsed row.** It reads as a build log, and the live sentence says more.
- **Two-line collapsed card** (title row + live line under it). It jumps when the turn resolves. One row in every state is the whole trick.
- **Collapsing the card to a chip / inline link** ("14 steps ›" after the answer). A chip can't host the running state or Stop, and it moves below the answer, where the operator's eye is not while waiting.
- **Grouping by activity across the whole turn.** It loses the narration's order ("Let me check the tests first…" would sit above a group of edits that came later).
- **Animating the card open with height.** v5 anti-goal.
- **Monospace in group rows** (e.g. showing `startSessionRpc` in mono). Monospace means "a literal the system interprets" (v5 §6), which belongs one level down. Search patterns stay in Inter in the sentence.
- **Putting the permission request inside the card.** It would be hidden behind a collapsed card exactly when it matters.
- **A "mode" toggle** in the header. The only setting is Show the work, in Settings.

## 10. Where I was guessing (explicitly)

1. The tool-name and command regexes (§1) cover Claude Code tools and common JS/Python runners. Codex tool names and the bridge's real `tool_output.payload.tool_name` values need to be checked against real journals.
2. Where "turn duration" starts: the operator's message, or the agent's first event? I used the operator message.
3. How today's thread renders bridge notices and a turn-ending error when Show the work is ON. I drew them as agent text; `component-map` marks this `unverified`.
4. The live `.mj_AccountMenu` is positioned `top:44px; right:8px`, which suggests a header anchor. The brief says sidebar gear. The mock anchors it to the sidebar footer.
5. The tracker item card: I drew a stand-in, because I didn't read `tracker/cards.tsx`.
6. Whether a failed step's deep view should show *all* later attempts or only the next passing one. I show the next passing one.
7. 400 MB is the brief's number. It should come from the bridge if it varies per box.
8. Inter 500 is used heavily (as in live). The package ships InterVariable so 500 renders true. The app's own `fonts.css` only ships 400/600, so live may be synthesizing 500 → 400. Worth checking in the auto-diff.

## 11. Census (normalized, measured)

`census.json` is produced by `tools/export.js`: getComputedStyle over every element of all 44 presets in both themes. After normalization: **27 distinct font declarations, 24 spacing values, 11 radii**. All the new v6 components (TurnCard, TurnError, SystemNotice, NewSessionSplit, sheet fields, switch, segmented) use only named roles (`--cpd-font-micro / meta / label / body-sm / body`, `--mj-font-label-sm`, `--mj-font-mono`) and the 4px grid (2/4/6/8/12/16/24). The off-scale values that remain are all **live literals in reused cards** (`13.5px/20px` prompt question, `12.5px/16px` buttons, `10px` eyebrows, 7/9/10/14px radii, 5.5/11/13/15px paddings). They are kept on purpose, because the design reuses those cards unchanged. Normalized this round: step file rows 5→6px, Stop 3→4px, folder list 3→4px, inline code 5→4px, "default" tag → `--cpd-font-micro`, two ad-hoc 500 12/16 declarations → `--mj-font-label-sm`, a 700 bold → 600.

## 12. What I'd want before the next round

- Real journals from both agents (tool names, the ratio of narration to steps, how often a turn has 0 steps).
- The bridge's `/restart --browser` status events (queued → restarting → on), so the chip and notices come from events rather than timers.
- A decision on accent-as-text contrast (§5).
