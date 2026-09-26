# v6 → current app: delta

Baseline: `easelyte/matron-web@main`, tree `2a1b2bad2046` (2026-09-26). Grounded in `src/journal/shell.pcss` (read), the journal.pcss build shipped as matron-web@1.12.11-rc.0 (read), and greps of `components.tsx` / `types.ts`.

## Unchanged when Show the work is ON

With **Show the work** switched on, the thread renders every step inline exactly as it does today: every `tool_output` is a `details.mj_ToolCard`, every `diff` is a `.mj_DiffCard`, narration is prose, `.mj_Activity` "Thinking" shows while running, and bridge notices render as they do now. `static/*-thread-on.html` is the reference. Nothing about those cards changes. The only v6 difference in that mode is the Settings menu itself.

Also unchanged in both modes: operator bubbles and agent flat prose (`.mx_EventTile[data-self]`), the composer, the header layout, every break-through card (`.mj_PromptCard`, `.mj_PromptCard_permission`, `.mj_PeerMessage`, `.mj_SpawnOutcomeRow`, `.mj_Image`, `.mj_File`, tracker cards), and all tokens in `shell.pcss`.

## New when Show the work is OFF (the default)

1. **One "Under the hood" card per operator turn with ≥1 step** (`.mj_TurnCard`, new), as the first block of the agent tile. It hosts the grouping algorithm (GENERATIVE-SYSTEM §1), the live line (§2), and deep detail, which **reuses** `.mj_DiffCard` and `.mj_ToolCard` markup, with border and radius removed inside the panel.
2. **Turns with no steps have no card.**
3. **Mid-turn narration moves into the card.** The answer (text after the last step) stays as prose below it.
4. **Turn-ending error** leaves the card as `.mj_TurnError` (new, `role=alert`).
5. **Bridge system notices** become `.mj_SystemNotice` (new): one tertiary meta line, no avatar.
6. `.mj_Activity` "Thinking" is **not shown** in this mode, because the card's live line replaces it.

## Other surfaces

7. **Settings menu** (`.mj_AccountMenu`): items become identity (username + server) · **Show the work** (switch + hint) · hairline · Sign out. **"Edit a file" is removed**, because editing lives in the file explorer. New: `.mj_RoomItemMenu_item_switch`, `.mj_Switch`, `.mj_MenuHint`.
8. **Session menu** (header ⋯, `.mj_HeaderMenu.mj_RoomItemMenu`): gains **Enable browser tools** with a hint line, in five states (idle / queued / restarting / on / Codex-unavailable).
9. **Enable browser tools confirm**: new dialog on the existing `.mj_UploadConfirm_queue` shell. One primary; "Restart now" is secondary and appears only while the agent is mid-task.
10. **Header chip** "Restarting after this step" (`.mj_HeaderChip`, new; reuses `.mj_Spinner`).
11. **New session is a split button** (`.mj_NewSessionSplit`, new). `.mj_NewSessionButton` becomes its main segment and **starts a session immediately with defaults**. The ⋯ segment opens the options sheet. Adds starting / error / uncertain / no-box states under the button.
12. **Options sheet** (`.mj_NewSessionSheet`): new field set: folder radio list with a "default" tag and "Other folder…", Claude | Codex segmented, model select, browser tools switch, first task, "Remember as my defaults", box caption.

## Tokens

| New name | Maps to | Status |
|---|---|---|
| `--mj-warn-ink` | — (amber text; `--cpd-color-usage-medium` is 2.2:1 as text) | genuinely new, both themes |
| `--mj-warn-dot` | `--cpd-color-usage-medium` | alias |
| `--mj-warn-tint` | — (Stop hover) | genuinely new |
| `--mj-accent-border` | the literal `rgb(13 148 136 / 25%)` in `.mj_NewSessionButton` / `.mj_PromptCard_permission` | alias of a live literal |
| `--mj-font-label-sm` | the literal `500 12px/16px` in `.mj_NewSessionSheet label` | alias of a live literal |
| `--mj-font-mono`, `--mj-font-mono-strong`, `--mj-font-modal-title` | live literals in `.mj_ToolCard pre`, `.mj_ToolCard summary code`, `.mj_UploadConfirm_title` | aliases |
| `--mj-live-xfade`, `--mj-live-min-interval`, `--mj-live-elapsed-after`, `--mj-slow-after` | — | new (motion / timing) |
| `--mj-card-expand`, `--mj-group-expand` | `--cpd-dur-fast` | alias |
| `--mj-deep-open`, `--mj-resolve` | `--cpd-dur-med` | alias |
| `--mj-bp-pane-narrow` 480, `--mj-bp-pane-medium` 760, `--mj-bp-sidebar-min` 224 | — | new (breakpoints on the chat pane) |
| `--mj-z-menu` 30, `--mj-z-modal` 50 | v4 layering values | alias of live z-indexes |

Everything else in `design-tokens.json` is an existing `--cpd-*` / `--mj-*` token with its live value.
