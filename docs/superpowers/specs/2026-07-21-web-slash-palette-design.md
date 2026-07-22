---
title: "Web journal client — slash-command palette + recent-folder completion"
status: approved
spec_review: "converged round 5 (2026-07-21); Claude LGTM rounds 3-5, all Codex findings applied through round 5; convergence called on findings-tier (safety-critical exhausted; round-5 items were edge/a11y/deploy-over-specification, all incorporated)."
date: 2026-07-21
loop: 474
owner: easelyte
approach: "C — full palette: bridge-command list + prefix filter + /start//workdir recent-folder completion (localStorage) + keyboard nav + tap. Faithful port of apple's SlashCommandPalette/ComposerViewModel, scoped to the commands THIS journal bridge actually honors."
base_branch: "feat/slash-palette off origin/main (fork-main da08c13). The composer has diverged from Dan's cf7646f (captions, session-controls, #456 banner, diff-cards), so the feature is built on fork-main to deploy clean. A cross-fork PR to Matronhq/matron-web (base master) is an OPTIONAL later port, NOT a build constraint — the new module + inline component are net-new (grep 'slash|palette' on origin/main components.tsx = 0), so the port is a clean cherry-pick with no composer-merge collateral."
rejected_alternatives:
  - "A (minimal: static command dropdown, click-to-prefill only, no keyboard nav, no folder completion): ~1 module + ~40 LOC component. Drops the folder-completion win the loop explicitly names and the keyboard nav the desktop-primary workflow wants. Re-opens the gap immediately."
  - "B (slim-down: command list + filter + keyboard/tap, DROP recent-folder completion): removes the RecentFoldersStore + folder-mode parsing (~40% of the pure-logic surface). Loses /start//workdir path completion. Rejected because the operator repeatedly starts sessions in explicit workdirs via `/start <path>` / `/workdir <path>` (and flagged forms like `/start --claude <path>`), so recent-path completion is a real, repeated keystroke saving. NOTE (round 4 Codex B2): the earlier draft justified this with `!start --worktree <slug>`, but the JOURNAL bridge's /start does NOT support --worktree (only --browser/--claude/--codex + a single-token workdir; --worktree is being PORTED to the journal bridge under loop #477, not yet landed — verified index.js:4521-4585). The worktree workflow is a Matrix-bridge / future-journal-bridge form; the completion feature stands on the real workdir/flag forms this bridge DOES honor today, and gains --worktree completion for free once #477 lands (the flag-skip grammar already handles arbitrary leading --flags)."
  - "Copy apple's BotCommandCatalog verbatim: apple's catalog lists /esc, /context, /compact, /mcp, /model etc. as /-triggers. On THIS journal bridge, /context and /compact are NOT bridge commands (not in BRIDGE_COMMAND_NAMES) — they'd fall through to the TUI as claude-native slash commands (works in interactive mode, becomes literal text in print mode), and /esc is a rescue keystroke that only matches the ! prefix. Sourcing from apple blindly would surface commands that silently break by mode. Rejected in favor of sourcing from the bridge's own honored set."
related_principles:
  - "P2 Canonical source — the command catalog is sourced from the bridge's real honored set (lib/command-dispatch.js BRIDGE_COMMAND_NAMES + the !help display text), not a hand-copied apple list that can drift from what this bridge accepts. Static (no discovery endpoint exists yet) but derived from the one authoritative surface."
  - "P3 Fail-visible — the catalog surfaces ONLY commands guaranteed to work regardless of session mode (interactive vs print). Commands that silently become literal text in print mode (/context, /compact) are excluded from v1 rather than offered-and-broken. A storage read failure degrades to an empty recent-folders list, never a thrown palette."
  - "P7 Verify third-party APIs against source — the accepted prefixes (both / and !), the honored command names, and the /start//workdir folder-arg grammar were read from the live bridge (command-dispatch.js classifyBridgeCommand, index.js handleCommand switch), not assumed from apple's catalog."
  - "P8 Guard boundary inputs — the palette parses the untyped composer string into typed intent (command-mode vs folder-mode vs neither) at one boundary; localStorage reads are wrapped (malformed/absent → empty), mirroring conversation-flags.ts."
  - "P18 Cognitive budget — pure logic lives in a new slash-palette.ts (~200-250 lines incl. dense JSDoc, JSX/asset-free, unit-tested — apple's equivalent logic across BotCommand/ComposerViewModel-slice/RecentStartFolders is ~300 Swift lines, so ~200-250 TS is the realistic budget, still one screen of concerns); the React SlashCommandPalette component lands INLINE in components.tsx (no file split — see constraint)."
constraint: "components.tsx and client.ts must NOT be split — matron-web stays structurally aligned with Matronhq/matron-web upstream (memory: project_matron_web_stays_dan_upstream_aligned). The SlashCommandPalette component + its wiring land INLINE in the existing Composer() in components.tsx; all pure logic (catalog, filter, mode-detection, folder parsing, RecentFoldersStore) goes in a NEW src/journal/slash-palette.ts module so it is reachable by jest (testMatch = test/unit-tests/journal/**/*-test.ts, .ts only, no svg moduleNameMapper — the pure module imports no JSX and no assets). Styles in journal.pcss (mx_/mj_ prefixes); any needed icon in icons.tsx. P18 TENSION (round 3 Codex M4): components.tsx is already ~2273 lines, and inlining more grows it — a real P18 violation. This is an OPERATOR-ACCEPTED tradeoff, not an oversight: the operator decided 2026-07-18 not to split matron-web files unilaterally (every structural fork-divergence taxes upstream merges), and the split is tracked as an upstream proposal to Dan (loop #448). This feature MINIMIZES the added surface — all heavy logic (the P18-compliant part) lives in the separate ~200-250-line slash-palette.ts; only a thin presentational component + state wiring go inline. Splitting here would diverge the fork structure the constraint exists to preserve; the right fix is #448 (converge both forks), not a local split."
open_decisions:
  - "PREFIX (flippable in one constant per catalog entry): v1 prefills /-triggers (apple parity + matches the bridge's own !help display, which shows /start etc). The bridge accepts BOTH / and ! (classifyBridgeCommand), so ! would work too and matches operator muscle-memory in this workspace. Chosen /; each BotCommand owns its full trigger string, so flipping is a per-entry edit, not a rewrite."
  - "esc: included as the literal trigger `!esc` (the one !-prefixed entry) because /esc does NOT map on this bridge (esc is a rescue keystroke matched only on !esc/!escape/!stop). Reliably works in both interactive and print mode."
intentional_apple_divergences:
  - "open-gate requires a non-empty command match (`commands.length>0`) in command mode — apple's showPalette opens even on zero matches (empty box). Web hides the empty palette. Intentional UX improvement."
  - "folderCompletionPartial SKIPS leading `--flag` tokens — apple's does NOT (a flag makes the partial multi-token → apple returns nil → no completion for `/start --claude /op`). Web mirrors recentFolderArgument's flag-skipping so completion works for the flagged forms the journal bridge honors (`/start --claude <path>`, `/workdir --codex <path>`, `--browser`). (Round 4 Codex B2: NOT `--worktree` — the journal bridge doesn't support that flag yet; #477 ports it. The grammar is flag-agnostic so it'll cover --worktree automatically once landed.) Resolves the §3.1/§2.1/§5 contradiction Codex flagged round 1."
  - "folderCompletionPartial matches the command word case-INSENSITIVELY (`/START`, `/Start`) — apple uses case-sensitive `==`. Web is consistent with its own ci filterCommands/isCommandMode. (round 1, Claude #2.)"
  - "RecentFoldersStore dedup + folderSuggestions exact-match exclusion are case-SENSITIVE — apple uses caseInsensitiveCompare. The stored paths name directories on the Linux bridge machine (case-sensitive filesystem), so `/srv/App` and `/srv/app` are DISTINCT identities; ci dedup would destroy one. Prefix-match for suggestion DISPLAY stays case-insensitive (a UX nicety that loses no data). Fixes the deterministic path-identity data loss Codex B2 flagged (round 1)."
  - "Escape dismisses the palette (suppress-until-next-edit) — no apple equivalent (apple has no keyboard dismiss). Additive, like Tab-to-complete-first."
---

# Web journal client — slash-command palette + recent-folder completion

## 1. Problem & goal

The web composer (`components.tsx` `Composer()`, ~1896) is a plain `<textarea>` with **zero slash handling** — a user who types `/start` gets no affordance; they must know the exact command and arguments by memory. The apple client (`Matron/Features/Chat/Composer/SlashCommandPalette.swift` + `MatronShared/Sources/ViewModels/ComposerViewModel.swift`) shows a dropdown palette above the composer that:

- surfaces the bridge's commands (filtered as you type a `/` or `!` prefix),
- offers recent-folder completion for `/start` / `/workdir`,
- and on tap/select prefills the composer with `<trigger> ` (trailing space, caret positioned for arguments).

**Goal:** reach parity with apple's palette on the web composer, scoped to the commands **this journal bridge actually honors**. Client-only UX — no bridge or journal-server contract change.

Loop #474. Apple parity reference read in full (both files above). Mac-only affordances (`⌘K` pinned-open, Up/Down sent-message history recall) are out of scope — the web composer has no history recall and no pin shortcut; the palette opens purely from typing, as on iOS.

## 2. What the bridge actually honors (source of truth for the catalog)

Read from the live journal bridge (`/opt/matron/bridge-journal`, `journal-deploy`):

- **Both `/` and `!` prefixes are accepted.** `lib/command-dispatch.js` `classifyBridgeCommand(text)`: `if (!(text.startsWith('!') || text.startsWith('/'))) return null;` then matches the command word (case-insensitive) against `BRIDGE_COMMAND_NAMES` and normalizes to the `!`-form `handleCommand` dispatches on.
- **`BRIDGE_COMMAND_NAMES`** (the set intercepted before any Claude turn): `start, stop, restart, resume, workdir, status, show, show_working, working, sessions, help, agent, switch, mcp, model, mode, effort, cost, usage, limits, tools, login, logout`.
- **`!help` display list** (the operator-facing canonical surface, `index.js` ~5112) shows the `/`-prefixed forms with summaries + arg hints. The catalog copies these summaries/hints verbatim so palette text == help text (P2).
- **`esc`** is NOT a bridge command — it's a rescue keystroke matched only on `!esc`/`!escape`/`!stop` (`classifyRescueKeystroke`) / `!esc`/`!escape` in print mode (`classifyPrintRescue`). Surfaced as literal trigger `!esc`.
- **`/context`, `/compact`** are claude-native, NOT bridge commands — excluded from v1 (see rejected_alternatives + §7 follow-ups).

### 2.1 Catalog (v1)

`slash-palette.ts` exports a static `CLAUDE_BRIDGE_COMMANDS: BotCommand[]`. `BotCommand = { trigger: string; summary: string; argHint?: string }` — `trigger` is the FULL string including its leading char (`/start`, `!esc`), mirroring apple's `BotCommand.trigger`.

**Summaries/argHints are transcribed VERBATIM from the bridge's live `!help` plain-text output** (`index.js` `case '!help'`, ~5113-5145) — NOT from apple's Swift catalog (round 1 Claude #1: the first draft had drifted to apple's wording). The `slash-palette.ts` catalog carries a `// source: bridge lib/command-dispatch.js BRIDGE_COMMAND_NAMES + index.js !help text — resync on bridge command changes` comment (P2 pointer; see §7 drift follow-up).

| trigger | argHint | summary (verbatim from bridge `!help`) |
|---|---|---|
| `/start` | `[--claude\|--codex] [--browser] [workdir]` | Start a new session (creates a new room) |
| `/stop` | | Stop the current session |
| `/restart` | | Stop and immediately resume the session (--browser also accepted) |
| `/resume` | `[--claude\|--codex] <n\|id>` | Resume a session from that agent |
| `/sessions` | `[--claude\|--codex]` | List past sessions for an agent |
| `/workdir` | `[--claude\|--codex] <path>` | Start a session in a different directory |
| `/status` | | Show current session info |
| `/agent` | | Show the current agent |
| `/switch` | `<claude\|codex>` | Hand this conversation to the other agent |
| `/working` | | Toggle tool call visibility |
| `/mcp` | | Show MCP server status |
| `/model` | | Show current model |
| `/effort` | `[level]` | Show or set effort level |
| `/mode` | `[interactive\|print]` | Show or switch interactive vs non-interactive |
| `/login` | | Log in to your Anthropic account |
| `/logout` | | Log out of your Anthropic account |
| `/cost` | | Show session cost |
| `/usage` | | Show token usage |
| `/limits` | | Show subscription usage limits (session & weekly) |
| `/tools` | | List available tools |
| `/help` | | Show this help message |
| `!esc` | | Cancel the current turn without killing the session |

The transcription source is the **plain-text `!help`** block (`index.js` ~5113-5137), NOT the HTML variant (~5160-5180) — they differ (`/agent` plain="Show the current agent" vs html="Show the current coding agent"; `/switch` likewise). Plain is canonical because it's the always-rendered fallback (HTML only ships when telegramify/entities are enabled). Round 2 M1 caught three rows that had used the HTML/apple wording; all now match plain `!help`.

Notes:
- **`/start` condenses the three separate `!help` `/start` lines** (bare, `<workdir>`, `--browser [workdir]`) into ONE palette row with a combined `argHint` that preserves `--browser` — a deliberate, documented condensation (not the silent `--browser` drop Claude #1 flagged), since a palette row per flag-variant is noise.
- **Intentional summary deviations from a strict char-for-char `!help` copy** (only these): `/login`/`/logout` drop the trailing "(auto-switches to interactive mode)" clause (length; not load-bearing for discovery); `!esc` is sentence-cased ("Cancel…") for palette-row consistency with the other rows, since its `!help` source is a lowercase mid-sentence tip line, not a command-list entry. Every other row is char-for-char plain `!help`.
- `show`/`show_working` are internal aliases of `/working`, not in the `!help` display — omitted, matching the operator-facing surface.

## 3. Architecture

### 3.1 New pure module — `src/journal/slash-palette.ts` (JSX/asset-free, unit-tested)

Mirrors apple's `BotCommandCatalog` + the mode/parse helpers on `ComposerViewModel`, and `RecentStartFolders`. All functions pure except the store (localStorage), which follows `conversation-flags.ts`'s wrapped-read pattern.

```ts
export interface BotCommand { trigger: string; summary: string; argHint?: string }
export const CLAUDE_BRIDGE_COMMANDS: BotCommand[];  // §2.1

// Case-insensitive prefix filter. FIRST strips leading whitespace, THEN a leading / or !.
// Empty/prefix-only → full list. The leading-whitespace strip is LOAD-BEARING and must match
// isCommandMode's (round 2 Codex M1): without it, `"  !s"` enters command mode (isCommandMode
// strips ws) but filterCommands returns [] → §3.3 `open` is false → command mode with no palette.
// Both functions share the same `input.replace(/^\s+/, "")` normalization as step 1. (apple's
// filteredCommands computed property strips ws before calling BotCommandCatalog.filter; we fold
// the strip into filterCommands so the two can't drift.)
export function filterCommands(commands: BotCommand[], input: string): BotCommand[];

// True when input (leading-ws-stripped) starts with / or ! and is a single token.
// (apple ComposerViewModel.showPalette's command branch)
export function isCommandMode(input: string): boolean;

// The partial path token when input is `/start`|`/workdir` (command word matched
// case-INSENSITIVELY — divergence from apple's cs ==, consistent with our ci filter) + ws,
// SKIPPING leading `--flag` tokens, then at most one more non-flag token with no trailing ws;
// else null. DIVERGES from apple's folderCompletionPartial (which returns nil once a flag makes
// the arg multi-token): we skip leading --flags so `/start --claude /op` → `/op` (Codex B1).
// Grammar (verified in Node against every §5 case — round 2 B1):
//   /^\s*[/!](start|workdir)\s+(--\S+\s+)*((?!--)\S*)$/i  → captured group 3 is the partial.
// The `(?!--)` negative-lookahead on group 3 is LOAD-BEARING: without it a trailing unterminated
// flag (`/start --claude`, no trailing ws) falls into group 3 and wrongly returns "--claude"
// instead of null. Equivalent token-walk (authoritative if the regex is unclear): strip leading
// ws + prefix char; ci-lowercase the command word up to the first ws, require ∈{start,workdir}
// and require ws after it; the partial is the trailing non-ws run (everything after the last ws);
// return null if that trailing run starts with `--`, or if any token BETWEEN the command word
// and the trailing run is not a `--flag`.
export function folderCompletionPartial(input: string): string | null;

// Replace input's current input with trigger + " ". (apple selectCommand) — pure.
export function applyCommand(trigger: string): string;

// Replace input's trailing \S* token with path (no trailing space). (apple selectFolder) — pure.
// (Only ever called with a `path` from folderSuggestions, i.e. a completed recent folder.)
export function applyFolder(input: string, path: string): string;

// The folder path after /start|/workdir (either prefix, command word ci), skipping leading
// `--flag` tokens. COMMAND-SPECIFIC grammar, matching the bridge's two DIFFERENT handlers
// (round 4 Codex B1 — verified against index.js):
//   - /workdir → the ENTIRE post-flag remainder JOINED with single spaces (bridge does
//     `workdirAgentFlags.rest.join(' ')`, index.js:4926) → `/workdir /srv/My Project` = "/srv/My Project".
//   - /start → ONLY the FIRST post-flag token (bridge does `agentFlags.rest[0]`, index.js:4538) →
//     `/start /srv/My Project` = "/srv/My" (the bridge ignores " Project"; /start takes a single-token
//     workdir — a space path must use /workdir). AND return null when that first token is the
//     force-fresh SENTINEL `now` or `fresh` (index.js:4539 `arg === 'now' || arg === 'fresh'`) — those
//     are not folders and must never be recorded (round 4 Codex M3).
// So: /workdir joins (apple's first-token-only would truncate — round 3 Codex M2), /start does NOT
// join (apple's first-token-only is CORRECT for /start; round 3's "always join" was wrong for /start).
// e.g. `/start --claude /a b c`→"/a" (bridge rest[0]); `/workdir --codex /a b c`→"/a b c"; `/start now`→null.
export function recentFolderArgument(text: string): string | null;

// localStorage-backed, most-recent-first, cap 15. Keyed by session identity with a VERSIONED
// prefix following the existing client.ts convention (matron_journal_*_v1): key =
// `matron_journal_recent_start_folders_v1:${encodeURIComponent(session.serverUrl)}:${session.userId}`
// — the SAME 3-part template conversation-flags.ts makeIdSetStore.storageKey builds (that helper
// is the exported, reusable shape reference; storeSelectedConversation is module-private and can't
// be imported — round 1 Claude #6). record()/matches(prefix) as apple RecentStartFolders, EXCEPT:
//   - dedup + identity are case-SENSITIVE (paths name Linux bridge dirs — /srv/App != /srv/app;
//     Codex B2). Only matches()'s PREFIX filter stays ci (display nicety, loses no data).
//   - BOTH reads AND writes are wrapped in try/catch (malformed/absent/quota/disabled → degrade,
//     console.warn, NEVER throw) — mirrors conversation-flags.ts reads, EXTENDED to writes so a
//     record() during send() can never reject the send path (Codex M2, P3).
// session is optional (ClientState.session?, types.ts:184): when undefined (pre-login / no active
// session) returns a NO-OP store (record() drops, matches() → []), so the command list still works.
export interface RecentFoldersStore {
  record(path: string): void;   // fail-silent on storage write error — never throws
  matches(prefix: string): string[];  // ci prefix filter, most-recent-first; empty prefix → all
}
export function makeRecentFoldersStore(session: Session | undefined): RecentFoldersStore;

// Folder suggestions for the current input: [] unless folderCompletionPartial(input) is
// non-null, else store.matches(partial) with an exact case-SENSITIVE match of partial removed
// (Codex B2 — never hide a distinct-cased sibling path), capped to 8. Exported (not
// component-inline) so the logic is unit-tested. Mirrors apple folderSuggestions, PLUS:
// when the command is `/start` (single-token workdir), suggestions CONTAINING WHITESPACE are
// EXCLUDED — a space path recorded via `/workdir` must not be offered under `/start`, where the
// bridge would truncate it at the first token (`rest[0]`) and run a different directory than the
// UI shows (round 5 Codex B1). `/workdir` suggestions are unfiltered (it joins the remainder).
// The command is read from the same parse as folderCompletionPartial. Divergence from apple
// (which shares one unfiltered store across both commands and has this latent mismatch).
export function folderSuggestions(input: string, store: RecentFoldersStore): string[];
```

Non-empty folder suggestions take priority over the command list (the two never both qualify — command mode is single-token, folder mode requires a completed command word + ws).

**Space-containing paths (round 3 Codex M2 / round 4 Codex B1):** only **`/workdir`** accepts spaces in paths (bridge `rest.join(' ')`); **`/start` takes a single-token workdir** (bridge `rest[0]`), so a space path there is truncated by the bridge itself — space paths must use `/workdir`. For `/workdir`, RECORDING stores the full `/srv/My Project`. COMPLETION (`folderCompletionPartial`) keeps the single-token `\S*` partial for both commands, and this is sufficient: the user gets suggestions while typing the pre-space portion (`/workdir /srv/My` → partial `/srv/My` → `matches("/srv/My")` prefix-matches the stored `/srv/My Project` → `applyFolder` inserts the whole `/srv/My Project`, replacing the trailing `/srv/My`). Once the caret is PAST a space, live suggestions stop (the partial is no longer a single token) — an accepted degradation, since the full path is already recorded and re-suggestible next attempt. No path-identity is lost.

### 3.2 Inline React component — `SlashCommandPalette` in `components.tsx`

Rendered inside `Composer()` above `mx_MessageComposer_row` when the palette is open (parity with apple stacking it above the input). Props: `{ commands: BotCommand[], folders: string[], highlighted: number | null, onHighlight: (index: number | null) => void, onSelectCommand: (cmd: BotCommand) => void, onSelectFolder: (path: string) => void }`. `highlighted` is INPUT-only (owned by `Composer()`); **`onHighlight` is the required setter** so mouse hover can update the parent state the Enter handler reads (round 2 Codex B2 — without it, a hovered row would render highlighted via CSS while `Composer` still holds `null`, and Enter would send the literal `/st`). Renders folder rows when `folders` non-empty, else command rows (trigger + argHint + summary). Mouse: `onMouseEnter` row → `onHighlight(index)`.

**Tap/click selection MUST keep the textarea focused (round 5 Codex M2):** a row selects via **`onMouseDown` with `event.preventDefault()`** (NOT `onClick`). `onClick` fires after the pointerdown blurs the textarea — on mobile that dismisses the software keyboard and moves the caret off the composer, breaking the "prefill `<trigger> ` and keep typing arguments" workflow. `preventDefault` on `mousedown` stops the blur, so the textarea keeps focus and the caret sits at the end of the prefilled text after `setBody`. (Touch fires a compatibility `mousedown`, so this covers touch too.)

**ARIA (combobox pattern — round 5 Codex M3):** the FOCUSED element is the textarea, so the combobox relationship lives THERE, not on the (unfocused) listbox: the textarea gets `role="combobox"`, `aria-expanded={open}`, `aria-controls={listboxId}`, and `aria-activedescendant={highlighted != null ? rowId(highlighted) : undefined}`. The palette container is `role="listbox"` with `id={listboxId}`; each row is `role="option"` with a stable `id={rowId(index)}`. This way a screen reader on the focused textarea is told which option is active as ArrowUp/Down move the highlight (putting `aria-activedescendant` on the listbox, as the earlier draft did, pointed AT an element that never holds focus — inert to AT).

**Scroll-highlighted-into-view (Codex M4):** the container is a `max-height` scroll box (§3.5) and the 22-command list overflows it. Keyboard highlight moves independently of scroll (focus stays on the textarea, `preventDefault` suppresses native scroll), so a `useEffect` keyed on `highlighted` calls `rowRef.scrollIntoView({ block: "nearest" })` on the newly-highlighted row's ref — otherwise ArrowDown past the visible rows moves the highlight offscreen and Enter selects a command the user cannot see. Guarded on `highlighted !== null`.

### 3.3 Composer wiring (state added to `Composer()`)

```
const [highlighted, setHighlighted] = useState<number | null>(null);
const [dismissed, setDismissed] = useState<string | null>(null);   // body value the palette is suppressed for
const store = useMemo(() => makeRecentFoldersStore(state.session), [state.session]);
```
(`state.session` is the `ClientState.session?: Session` the Composer already receives via its `state` prop; the store no-ops when it's undefined — §3.1.)

- **Derived open state:** `folders = folderSuggestions(body, store)`; `commands = filterCommands(CLAUDE_BRIDGE_COMMANDS, body)`; `open = body !== dismissed && (folders.length > 0 || (isCommandMode(body) && commands.length > 0))`.
- **onChange (existing):** after `setBody`, clear stale highlight (`setHighlighted(null)`) and lift dismissal if `body` changed (`if (dismissed !== null && next !== dismissed) setDismissed(null)`) — mirrors apple `handleInputChange`.
- **Highlight (mouse):** the `SlashCommandPalette`'s `onHighlight` prop (§3.2) is wired to `setHighlighted`, so hover updates the same state the keyboard/Enter path reads (round 2 Codex B2).
- **Select command:** `setBody(applyCommand(trigger)); setHighlighted(null)`, keep textarea focus. Trailing space makes `isCommandMode` false → palette closes (parity with apple's trailing-space caret rule).
- **Select folder:** `setBody(applyFolder(body, path)); setDismissed(applyFolder(body, path)); setHighlighted(null)`, keep focus (no trailing space — caret at path end).
- **Record on send:** `client.sendMessage(bodyInput)` returns `Promise<boolean>` (verified `client.ts:463` — `true` = message accepted into the outbox, `false` = early-out on empty/no-convo/child-convo). The existing `send()` already gates its `setBody("")` reset on this truthy return. Recording rides the same gate: after `if (await client.sendMessage(body))`, run `const f = recentFolderArgument(body); if (f) store.record(f);` then clear dismissal. `store.record` is fail-silent on storage errors (§3.1), so it can never turn a successful send into a rejected promise (Codex M1 truthy-contract concern resolved by the verified boolean; Codex M2 write-failure contained inside record()).
  - **Store semantics = ATTEMPTED, not bridge-confirmed (round 2 Codex M3):** the boolean gate is client-outbox acceptance, NOT proof the bridge accepted the workdir or started the session. A `/workdir /missing` the bridge later rejects still gets recorded. This is deliberate and matches apple (`RecentStartFolders` records on send, before any bridge outcome — the journal protocol exposes no per-command success signal to gate on). Acceptable because a failed folder is a harmless, ages-out (cap 15) stale suggestion, never a destructive action; and prefix-filtering means it only surfaces when the user re-types a matching prefix (i.e. they're heading back to it anyway). The store name means "folders you've *launched into*," not "folders that succeeded" — documented in the module doc so the semantics aren't ambiguous. Bridge-confirmed recording would need a new protocol signal — out of scope (§8).

### 3.4 Keyboard (extends the existing `onKeyDown`)

Existing handler (`components.tsx:1927-1932`): `if (event.key === "Enter" && !event.shiftKey) { preventDefault(); send(); }`. **When the palette is `open`, the new keydown logic runs FIRST and OWNS Enter** — in the swallow/select cases below it `preventDefault`+`return`s so control never reaches the old `send()`. That ownership is what makes the IME and Shift+Enter contracts hold (round 3 Codex B1/M5). New rules, only when `open`:

- **ArrowDown / ArrowUp:** `preventDefault`; move highlight within `[0, count-1]`; from no-highlight, Down→0, Up→last (apple `paletteMoveDown/Up`). Highlight change scrolls the row into view (§3.2).
- **IME-composing Enter** (`event.nativeEvent.isComposing || event.keyCode === 229`, any shift state): **early `return` WITHOUT `preventDefault`** — skip select AND send, but let the browser natively COMMIT the composed candidate. Structure this as the FIRST line of the unified `onKeyDown`, exactly mirroring the repo's own idiom at `components.tsx:2118` (`if (isComposing || keyCode===229) return;`). Do NOT `preventDefault` — cancelling a composing keydown can suppress the composition/input events and leave stuck/uncommitted text (W3C UI Events; plan-review round-2 Codex B1 corrected the earlier "swallow via preventDefault" wording). This skips select+send (so no partial text is sent mid-composition — the round-3 concern) while preserving native IME commit. §5 test (g) asserts nothing selected/sent AND `defaultPrevented === false`. Because this guard is the first line of the SHARED handler, it also fixes the pre-existing IME-Enter-sends gap on the palette-closed path — a strict improvement.
- **Plain Enter** (`!shiftKey`, non-IME): if `highlighted !== null` → `preventDefault` + select that row (command or folder per mode), do NOT send (apple `confirmPaletteSelection` true); if `highlighted === null` → fall through to the existing `send()` (Enter on a freshly-typed `/sta` sends the literal text).
- **Shift+Enter** (non-IME): fall through UNTOUCHED — browser inserts a native newline; the new logic does not `preventDefault`. The resulting multi-token `body` makes `isCommandMode` false, so `open` goes false next render and the palette **closes naturally** (round 3 Codex M5 — corrects the earlier "stays open" claim; §3.3's derived `open` governs, and a newline legitimately ends the command line). §5 test (c) asserts only the jsdom-provable part (no preventDefault / select / send).
- **Tab:** `preventDefault`; select the highlighted row, or the first row if none highlighted (web idiom — Tab always completes the top suggestion). No apple equivalent (Mac uses Return); additive.
- **Escape:** `preventDefault`; `setDismissed(body)` (suppress until the next differing edit) and `setHighlighted(null)`. Closes without altering text. No apple equivalent; additive.

`count = folders.length || commands.length` (folders win, mirroring the render).

*Pre-existing IME gap — now fixed as a side effect:* the existing `send()`-on-Enter path (`components.tsx:1927`) previously had no `isComposing`/keyCode-229 guard (unlike `UploadConfirmPage`'s caption textarea, `components.tsx:2118`). Because this feature adds the IME early-return as the FIRST line of the SHARED composer `onKeyDown`, the palette-closed path now also stops sending on an IME-commit Enter — a strict, in-scope improvement (the guard can't be scoped to "only when open" without re-introducing the send-on-IME bug the plan-review flagged). This aligns the message composer with the caption textarea's existing idiom.

### 3.5 Styles — `journal.pcss`

New `mx_SlashPalette` block: absolutely/flow-positioned above the composer row, max-height with scroll (apple caps at 220pt → web `max-height: 15rem; overflow-y: auto`), rounded, elevated surface using existing journal CSS custom properties (match the composer's existing surface tokens, dark-theme-first). Highlighted row uses the existing hover/selected token. Monospace trigger, muted argHint/summary (parity with apple's `.monospaced` trigger + secondary summary).

## 4. Parity matrix (apple → web)

| apple behavior | web |
|---|---|
| `BotCommandCatalog.claudeBridge` static list | `CLAUDE_BRIDGE_COMMANDS` (scoped to honored set) |
| `filter(byPrefix)` strip `/`,`!`, ci, empty→all | `filterCommands` (identical) |
| `showPalette` single-token `/`/`!` OR folder mode | `open` §3.3 — **+requires `commands.length>0`** (divergence: hides empty palette) |
| `selectCommand` → `trigger + " "` | `applyCommand` (identical) |
| `folderCompletionPartial` (cs cmd word, flag = nil) | `folderCompletionPartial` — **DIVERGES: ci cmd word + skips leading `--flags`** (§3.1, Codex B1 / Claude #2) |
| `folderSuggestions` matches, exclude exact **(ci)**, ≤8 | `folderSuggestions()` — **exclude exact is cs** (§3.1, Codex B2) |
| `selectFolder` replace trailing `\S*`, no space | `applyFolder` (identical) |
| `recentFolderArgument` first non-`--` token | `recentFolderArgument` — **command-specific: /workdir joins remainder, /start = first token + excludes now/fresh sentinels** (matches the two bridge handlers; Codex M2/B1/M3) |
| `RecentStartFolders` UserDefaults, ci dedup, cap 15 | `RecentFoldersStore` localStorage — **cs dedup** (Codex B2), cap 15, fail-silent writes |
| `paletteMoveDown/Up`, `confirmPaletteSelection` | ArrowDown/Up, Enter **(non-shift only)** §3.4 + scroll-into-view §3.2 |
| (no palette dismiss / no Tab-complete on Mac) | Escape-dismiss + Tab-complete-first — **additive, no apple equivalent** |
| `⌘K` pin, Up/Down history recall (Mac) | out of scope (no web equivalent) |

## 5. Testing

New `test/unit-tests/journal/slash-palette-test.ts` (`.ts`, babel-jest, jsdom — no JSX, no assets imported from the module). Cases:

- `filterCommands`: empty→all (22); `/sta`→**exactly `[/start, /status]`** (both prefix-match "sta"; `/stop` does NOT — 3rd char `o`≠`a`); `!STA`→same two (ci, prefix stripped); prefix-only `/`→all; `/zzz`→[].
- `isCommandMode`: `/start`→true; `/start x`→false (two tokens); `  !s`→true (leading ws); `hello`→false; `/`→true.
- **whitespace agreement (Codex M1):** `filterCommands(CLAUDE_BRIDGE_COMMANDS, "  !s")` returns the same non-empty set as `filterCommands(..., "!s")` (leading ws stripped first), so `isCommandMode("  !s") && commands.length>0` are BOTH true → `open` true. Regression guard for the strip-agreement.
- `folderCompletionPartial` (**flag-skip + ci command word — the round-1 divergences**): `/start `→`""`; `/workdir /op`→`/op`; **`/start --claude /op`→`/op`** (skips the flag — Codex B1); **`/start --claude --browser /o`→`/o`** (skips multiple flags); `/start --claude`→`null` (only a flag, no partial path token yet — the `(--\S+\s+)*` requires trailing ws after each flag, so a bare unterminated flag isn't a completed-flag-then-partial); **`/START /op`→`/op`** and **`/Workdir /o`→`/o`** (ci command word — divergence from apple); `/stop /z`→null (not start/workdir); `/start a b`→null (two NON-flag arg tokens).
- `applyCommand`: `/start`→`"/start "`; `!esc`→`"!esc "`. `applyFolder`: `/start /op`+`/opt/x`→`/start /opt/x`; flag-preserving `/start --claude /op`+`/opt/x`→`/start --claude /opt/x`.
- `recentFolderArgument` (**command-specific — round 4 Codex B1/M3**): `/start /opt/x`→`/opt/x`; `!workdir --codex /y`→`/y`; `/START --claude /z`→`/z` (ci); **`/workdir /srv/My Project`→`/srv/My Project`** (join — Codex M2); **`/start /srv/My Project`→`/srv/My`** (first token only — bridge `rest[0]`); **`/start --claude /a b c`→`/a`** vs **`/workdir --claude /a b c`→`/a b c`** (the /start-vs-/workdir grammar split); **`/start now`→null, `/start fresh`→null, `!start now`→null** (force-fresh sentinels, never recorded); `/start --claude`→null (flags only); `/stop /z`→null.
- `folderSuggestions` (exported): non-command input→[]; `/start /sr` with recents [`/srv/App`,`/srv/api`] → prefix-matches both (ci prefix); **case-sensitivity: `/start /srv/App` with recents [`/srv/App`,`/srv/app`] excludes ONLY the exact `/srv/App`, KEEPS `/srv/app`** (Codex B2 — distinct Linux paths); caps at 8 when >8 match; **command-aware space filter (round 5 Codex B1): `/start /sr` with recents [`/srv/My Project`,`/srv/api`] → returns ONLY `/srv/api` (the space-path is excluded under /start); the SAME input as `/workdir /sr` → returns BOTH** (space-paths allowed under /workdir).
- `RecentFoldersStore`: **record dedup is case-SENSITIVE** — recording `/srv/app` after `/srv/App` yields TWO entries (Codex B2), recording exact `/srv/App` twice yields one (moved to front); cap 15 drops oldest; `matches` prefix ci + most-recent-first; malformed/absent localStorage → `matches("")` = [] (wrapped read, no throw); **write failure (mock `setItem` to throw) → `record()` does NOT throw** (Codex M2, fail-silent); undefined session → no-op store (`record()` no-throw, `matches()`→[]); write persists round-trip under a `matron_journal_recent_start_folders_v1:...` key.

**Committed component keyboard test** (`test/unit-tests/journal/components-test.ts`, extending the existing suite — the precedent is already there: `components-test.ts` renders `MatronApp` via `createRoot`/`act` with `jest.mock`'d SVGs and has a "keyboard contract" test at ~line 606 + ArrowDown/Up `KeyboardEvent` dispatch at ~807-812). NOT conditional (round 1 Claude #4). Covers the `onKeyDown` wiring the pure module can't: (a) type `/st` → palette opens with command rows; (b) ArrowDown highlights row 0, Enter selects → body becomes `/start ` and NO message sent; (c) **Shift+Enter with a row highlighted: the handler does NOT `preventDefault`, does NOT send, and does NOT select a row** — asserting the handler stays out of the way and leaves the newline to the browser's native textarea default (round 2 Codex M2: a synthetic jsdom `keydown` can't observe the trusted native newline insertion, so the provable contract is "handler is a no-op on Shift+Enter"; the round-1 Claude #5 regression guard is exactly this no-preventDefault/no-select assertion); (d) Enter with no highlight sends the literal text; (e) Escape dismisses (palette gone, body unchanged); (f) Tab completes the first row; (g) **IME guard: a `keydown` Enter with `isComposing:true` (or `keyCode:229`) selects nothing and sends nothing** (round 2 M2/Codex-B1); (h) **folder path end-to-end (round 3 Codex M3):** seed the recent-folders store (localStorage) with `/srv/Project`, type `/workdir /srv/P` → assert FOLDER rows render (not command rows), a tap/click on the folder row sets `body` to `/workdir /srv/Project` (correct `onSelectFolder` callback, not the command one), and `onMouseEnter` on a row updates the highlight that Enter then consumes. This closes the P38 gap where all command-row tests pass while `Composer` never wires `folders`/`onSelectFolder`/`onHighlight` to the palette; (i) **recording gate (round 4 Codex M2):** with `client.sendMessage` mocked to resolve `true`, sending `/workdir /op/x` then asserting the store contains `/op/x`; and with it mocked to resolve `false`, asserting NO record — proving `store.record` sits inside the `if (await sendMessage(...))` gate (§3.3), not outside it, and that the headline recording path is actually wired (not just the store unit-tested in isolation). Reuses the existing SVG-mock + createRoot harness — no new test infra.

Verify: `corepack pnpm lint:types && corepack pnpm test && corepack pnpm lint && corepack pnpm build` in the worktree.

## 6. Deploy (operator-gated)

**The deploy MECHANICS are NOT part of this feature's contract** — the canonical journal-web deploy procedure is the operator-owned **CLAUDE.local.md web-deploy runbook** (build-in-place → backup → verify :8443 → restore-from-backup rollback), which the operator has run successfully for prior web features (captions, diff-cards). This spec does NOT re-derive that runbook (rounds 3-5 showed that re-specifying every `cp`/`mv`/recovery edge just generates rename-corner-case findings that the owned runbook already handles). Rounds 4-5 Codex B2/B3/M1 are resolved by de-scoping to the runbook rather than the spec inventing a parallel deploy sequence. This section specifies ONLY what is feature-specific:

- **Execution boundary (single, unambiguous — round 5 Codex B3):** the deploy is **operator-executed only**. An agent must NEVER run it autonomously — the build's `rimraf webapp` + the dir swap are state-modifying, so per R102 they require the operator as executor/confirmer. (There is exactly one operator; the runbook is a solo-operator manual step, so no concurrent-deploy serialization is needed — round 5 Codex M1.) This is the "all outward actions operator-gated" line, made explicit for the deploy.
- **R102-safe rollback preference:** when the operator runs the runbook's restore step, prefer rename-aside (`mv` the live dir to `webapp.failed.<ts>`, then restore the backup) over `rm -rf` (R102: `trash > rm`) — keeps the failed build for diagnosis. Mechanics + partial-failure recovery are the runbook's concern, not this spec's.
- **Feature-specific success condition (all must hold before the deploy is "accepted"):** `:8443` serves 200 AND the operator browser smoke-test confirms — (a) typing `/st` opens the palette, (b) selecting a row prefills `<trigger> ` and the textarea keeps focus (round 5 Codex M2), (c) a plain message still sends on Enter, (d) Shift+Enter inserts a newline (round-1 Claude #5), (e) a recent folder completes for `/workdir <partial>` (the headline path). Port-200 alone is NOT sufficient — the bundle can serve yet throw during composer init; if any check fails, roll back per the runbook.

THEN push `feat/slash-palette` to `easelyte/matron-web` + OPTIONAL cross-fork PR to `Matronhq/matron-web` (base `master`; easelyte is pull-only on Dan's web repo → independent PR, not stacked). Close #474 on merge. All outward actions (push, PR, live deploy) operator-gated.

## 7. Follow-ups (not v1)

- `/context`, `/compact`: claude-native, work in interactive mode only. Add behind a mode-aware guard once the client can read session mode, OR surface with a "interactive-only" note. Loop candidate.
- **Static-catalog drift (Codex M3, accepted for v1):** `CLAUDE_BRIDGE_COMMANDS` is a hand-maintained copy of the bridge's honored set — if a bridge release renames/removes a command without a synchronized web deploy, the palette offers a stale entry (falls through as a native slash command or, in print mode, literal text). This coupling is INHERENT to a static client catalog with no discovery endpoint — apple has the identical exposure (its own `// Phase 5+ config-driven` note). Accepted for v1 because (a) the honored set is stable and rarely changes, (b) the failure is degraded-not-dangerous (a stale command is a no-op / passthrough, never destructive), (c) the real fix is the config-driven catalog below, not a brittle cross-repo parity test the web repo can't run (it can't import the bridge's JS). Mitigation shipped in v1: the source-of-truth pointer comment on the catalog constant (§2.1) so the next editor knows where to resync.
- Config-driven catalog (apple's "Phase 5+") — the real drift fix: replace the static list with a bridge-served command manifest if/when a discovery endpoint lands. Cross-fork proposal to Dan.
- Propose the palette upstream to Dan (matron-web) so both forks converge (per project_matron_web_stays_dan_upstream_aligned).

## 8. Non-goals

- No bridge or journal-server change. No new wire fields. No `⌘K`/history-recall. No fuzzy matching (prefix only, apple parity). No server-side folder discovery (local history only, apple parity). No file-split of components.tsx/client.ts. No bridge-confirmed folder recording (attempted-only, §3.3).

## 9. Grounding (cross-repo coordinates — verified at spec time)

Codex's 5-file read cap (round 2 M4) prevented it from independently grounding these; verified here against source by the parent + the Claude subagent (both read the files). An implementer should re-confirm against the deploy checkouts before coding:
- `client.ts:463` — `sendMessage(bodyInput: string): Promise<boolean>` (true=outbox-accepted). ✓
- `types.ts:184` / `:24-28` — `ClientState.session?: Session`; `Session { serverUrl: string; …; userId: number }`. ✓
- `conversation-flags.ts:18-53` — `makeIdSetStore` builds `${keyPrefix}:${encodeURIComponent(session.serverUrl)}:${session.userId}`; wrapped localStorage reads. Storage-key SHAPE reference (this feature's store is an ordered-list, not a Set, so it doesn't reuse the Set semantics — only the key template + wrapped-IO pattern). ✓
- `components.tsx:1896` `Composer()`, `:1927-1932` `onKeyDown` (Enter+!shiftKey→send, NO IME guard), `:2119` `UploadConfirmPage` caption (HAS the IME guard). ✓
- `test/unit-tests/journal/components-test.ts:606` keyboard-contract test + `:807-812` Arrow KeyboardEvent dispatch — the committed keyboard-test precedent. ✓
- bridge `lib/command-dispatch.js:25-43` `BRIDGE_COMMAND_NAMES` + `classifyBridgeCommand` (both `/` and `!`, ci); `index.js:5113-5137` plain `!help` (catalog transcription source); `:4521+` `handleCommand` switch (`!`-dispatch). ✓
- apple `ComposerViewModel.swift:111-121` `showPalette`, `:135-138` `selectCommand`, `:198-251` folder logic, `:259-268` `recentFolderArgument`; `RecentStartFolders.swift`. ✓
