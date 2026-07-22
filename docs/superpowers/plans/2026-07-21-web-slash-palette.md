---
title: "Plan — Web journal client slash-command palette + recent-folder completion"
spec: docs/superpowers/specs/2026-07-21-web-slash-palette-design.md
loop: 474
date: 2026-07-21
owner: easelyte
risk: low
worktree: /opt/matron/web-journal-wt-slash-palette
branch: feat/slash-palette
tech: "React 18 / TypeScript, webpack build, jest (jsdom, babel-jest), testMatch test/unit-tests/journal/**/*-test.ts"
constraint: "No split of components.tsx / client.ts (upstream-aligned). Pure logic in NEW src/journal/slash-palette.ts (JSX/asset-free — jest-reachable). Component inline in components.tsx. Styles in journal.pcss AND shell.pcss (--cpd-* tokens) — shell.pcss holds the composer classes (.mx_MessageComposer*), so T-2.3's `position: relative` ancestor + the palette rules land there; both files edited, neither split."
---

# Plan — Web journal client slash-command palette + recent-folder completion

Implements `docs/superpowers/specs/2026-07-21-web-slash-palette-design.md` (spec converged spec-review round 5). Client-only UX; no bridge/journal-server change. TDD: the pure module (Phase 1) is written test-first; the React component (Phase 2) is covered by an extended component test (Phase 3).

## Grounding (verified against the worktree at plan time)

- Composer: `src/journal/components.tsx` `Composer()` at ~1896; existing `onKeyDown` at ~1927-1932 (`Enter && !shiftKey → preventDefault; send()`). `UploadConfirmPage` caption textarea IME guard at ~2119.
- `client.sendMessage(body): Promise<boolean>` at `client.ts:463` (true=outbox-accepted).
- `ClientState.session?: Session` (`types.ts:184`); `Session { serverUrl; userId }` (`types.ts:24-28`). Existing key template `${prefix}:${encodeURIComponent(serverUrl)}:${userId}` (`conversation-flags.ts` `makeIdSetStore`, and `storeSelectedConversation` at `client.ts:136`); existing `_v1` versioned prefixes (`client.ts:30-63`).
- CSS: Compound `--cpd-*` tokens (`--cpd-color-bg-canvas-default`, `--cpd-color-text-secondary`, `--cpd-space-Nx`, `--cpd-font-*`); existing dropdown positioning idiom `top: calc(100% + var(--cpd-space-2x))` (`journal.pcss:183`).
- Icons: `export function XIcon(props: IconProps): React.ReactElement` in `icons.tsx`.
- Tests: `test/unit-tests/journal/**/*-test.ts` (`.ts` only, babel-jest, jsdom, NO svg moduleNameMapper). `components-test.ts` renders `MatronApp` via `createRoot`/`act` with `jest.mock("...svg", () => "x.svg")`; dispatches `new Event(...)` / `KeyboardEvent`.
- Bridge grammar (source-of-truth, read-only — do NOT modify): `!start` uses `agentFlags.rest[0]` + `now`/`fresh` sentinels (`bridge-journal/index.js:4538-4539`); `!workdir` joins `rest.join(' ')` (`:4926`); both `/` and `!` accepted (`lib/command-dispatch.js` `classifyBridgeCommand`); honored set `BRIDGE_COMMAND_NAMES`.

## Task dependency graph

```
Phase 1 (pure module, TDD) ─── T-1.1 catalog+filter+mode
                            └── T-1.2 folder parsing (depends T-1.1 for file scaffold)
                            └── T-1.3 store + folderSuggestions (depends T-1.2 for folderCompletionPartial)
Phase 2 (UI, needs Phase 1 exports) ─ T-2.1 SlashCommandPalette component (components.tsx)
                                     └ T-2.2 Composer wiring + keyboard (components.tsx; same file → sequential after T-2.1)
                                     └ T-2.3 styles (journal.pcss; parallel with T-2.1/2.2)
Phase 3 (component tests, needs Phase 2) ─ T-3.1 components-test.ts cases (a)-(i)
Phase 4 (verify + deploy-prep) ─ T-4.1 full verify gate; deploy is operator-gated (not an execution task)
```

Phase 1 is fully independent of the UI and lands + goes green first. Phase 2 depends on Phase 1's exports. T-2.1 and T-2.2 both edit `components.tsx` → strictly sequential (no parallel edits to the monolith). T-2.3 (pcss) can land any time in Phase 2.

---

## Phase 1 — Pure logic module (`slash-palette.ts`), test-first

New file `src/journal/slash-palette.ts` (JSX/asset-free) + `test/unit-tests/journal/slash-palette-test.ts`. Every export is unit-tested. Spec §3.1, §5.

### T-1.1: Catalog + `filterCommands` + `isCommandMode`

- [ ] Create `src/journal/slash-palette.ts` with the file license header (copy the SPDX header block from `conversation-flags.ts`).
- [ ] Export `interface BotCommand { trigger: string; summary: string; argHint?: string }`.
- [ ] Export `const CLAUDE_BRIDGE_COMMANDS: BotCommand[]` — the 22 entries from spec §2.1 table, summaries/argHints VERBATIM from the plain `!help` block (`/agent`="Show the current agent", `/switch`="Hand this conversation to the other agent", `/help`="Show this help message", `/mode`="Show or switch interactive vs non-interactive", `/start` argHint `[--claude|--codex] [--browser] [workdir]`, `!esc` sentence-cased). Add the source-pointer comment: `// source: bridge lib/command-dispatch.js BRIDGE_COMMAND_NAMES + index.js !help text — resync on bridge command changes`.
- [ ] Export `filterCommands(commands, input): BotCommand[]` — normalize step 1 = strip leading whitespace (`input.replace(/^\s+/, "")`), step 2 = strip a leading `/` or `!`, case-insensitive prefix match; empty/prefix-only → full list. (Shared ws-strip with `isCommandMode` — spec §3.1, Codex M1 round 2.)
- [ ] Export `isCommandMode(input): boolean` — leading-ws-stripped, starts with `/` or `!`, single token (split on whitespace, count 1).
- [ ] Write `slash-palette-test.ts` cases: `filterCommands` empty→all(22), `/sta`→exactly `[/start,/status]` (`/stop` excluded), `!STA`→same two (ci), `/`→all, `/zzz`→[]; `isCommandMode` `/start`→true, `/start x`→false, `"  !s"`→true, `hello`→false, `/`→true; whitespace-agreement: `filterCommands(_, "  !s")` === `filterCommands(_, "!s")` non-empty.

**Acceptance:** `slash-palette-test.ts` green for these cases; `CLAUDE_BRIDGE_COMMANDS.length === 22`; no JSX/asset import in the module (grep the file for `.svg`/`tsx`/`import React` → none); `tsc --noEmit` clean.

### T-1.2: Folder-arg parsing (`folderCompletionPartial`, `applyCommand`, `applyFolder`, `recentFolderArgument`)

- [ ] **Shared internal parse helper (round-1 plan-review m2):** add a NON-exported `parseFolderCommand(input): { command: "start" | "workdir"; partial: string } | null` — the ONE parser that both `folderCompletionPartial` and `folderSuggestions` (T-1.3) call, so the "which command matched" logic exists once (no two independent regexes drifting).
- [ ] **Skip ONLY bridge-RECOGNIZED flags, not any `--token` (round-2 plan-review Codex B2, P2/P8):** the flag-skip must match the bridge's `extractAgentFlag` + `extractMcpExtraFlags` recognized set — `--claude`, `--codex`, `--browser`, `--agent=<x>` — NOT a generic `--\S+`. The bridge strips only THOSE; an UNKNOWN `--token` (typo `--claud`, `--bogus`) is treated by the bridge as the workdir arg. So an unknown `--token` must TERMINATE the flag-skip → no false completion. Add the source-pointer comment: `// recognized flags mirror bridge lib/agent-backend.js extractAgentFlag + lib/mcp-config.js extractMcpExtraFlags — resync if the bridge adds flags`.
- [ ] **Flag matching is CASE-SENSITIVE; command word is case-INSENSITIVE (round-3 plan-review Codex M1 — verified: bridge `extractAgentFlag` does `token === '--claude'` and `extractMcpExtraFlags` keys on exact `'--browser'`; only the COMMAND word is lowercased at index.js:4517, flags forwarded unchanged).** So a single `/i` regex is WRONG (it would skip `--CLAUDE`, which the bridge treats as a workdir). Implement `parseFolderCommand` as: (1) match the command prefix case-insensitively — `input.match(/^\s*([/!])(start|workdir)\s+/i)` — to get the command (lowercased) + the rest; (2) match flag tokens in the rest CASE-SENSITIVELY against exactly `--claude` / `--codex` / `--browser` / `--agent=<x>`; (3) the partial is the trailing `(?!--)\S*`. Do NOT put `/i` on the flag match. Tests: `/start --claude /op`→"/op"; `/start --CLAUDE /op`→null (uppercase flag NOT recognized, matches bridge); `/START --claude /op`→"/op" (command ci); `/start --claud /op`→null (typo); `/workdir --bogus /op`→null.
  - *Unicode-dash edge (accepted, not handled):* the bridge normalizes leading unicode dashes (`—claude` → `--claude`); the web does not. A mobile auto-corrected `—claude` won't match the web's `--` flag set → treated as the partial → no completion (safe degradation to no-suggestion, never wrong-completion; the bridge still runs the command correctly). Not worth the normalization surface.
- [ ] `folderCompletionPartial(input): string | null` — thin wrapper: `parseFolderCommand(input)?.partial ?? null`. Command matched case-insensitively, flags case-sensitively (M1 above). The `(?!--)` on the partial means an unrecognized `--token` (typo flag, or an uppercase `--CLAUDE`) can't be a partial → match fails → null → no false completion (B2/M1). Include the equivalent token-walk in a doc-comment.
- [ ] `applyCommand(trigger): string` → `trigger + " "`.
- [ ] `applyFolder(input, path): string` → replace input's trailing `\S*` run with `path` (no trailing space). Handles a space-containing `path` (replaces only the trailing non-space token).
- [ ] `recentFolderArgument(text): string | null` — COMMAND-SPECIFIC (spec §3.1, round 4 Codex B1/M3): parse command word (ci) + skip LEADING RECOGNIZED `--flag` tokens (the SAME `--claude|--codex|--browser|--agent=` set as above — an unknown `--token` is NOT skipped, matching the bridge; round-2 Codex B2); for `/workdir` return the full post-flag remainder joined by single spaces (matches bridge `rest.join(' ')`); for `/start` return ONLY the first post-flag token AND return null if it equals `now` or `fresh` (sentinels). Null if no path token / flags only / not start|workdir.
  - **Known limitation (round-1 m1 / refined round-2 Codex B2, documented not fixed):** the flag-skip is now recognized-flag-set-aware (B2) but still LEADING-only. So a TRAILING recognized flag — `/workdir /path --claude` — records `/path --claude` (a bogus entry) where the bridge strips `--claude` regardless of position and uses `/path`. Accepted, NOT fixed: every documented usage + the argHint puts flags BEFORE the path; a full anywhere-strip adds parsing surface for a rare case whose only cost is a harmless recent-folder entry that never matches a real dir and ages off at cap 15. (The DANGEROUS case — an unknown/typo leading flag causing wrong-dir completion — IS fixed by B2's recognized-only skip.)
- [ ] Tests: `folderCompletionPartial` `/start `→"", `/workdir /op`→"/op", `/start --claude /op`→"/op", `/start --claude --browser /o`→"/o", `/start --claude`→null, `/START /op`→"/op", `/Workdir /o`→"/o", `/stop /z`→null, `/start a b`→null; **unknown-flag (round-2 Codex B2): `/start --claud /op`→null** (typo flag not recognized → not skipped → partial `--claud` can't match → no completion), **`/workdir --bogus /op`→null**, and `/start --browser /op`→"/op" (recognized). `applyCommand` `/start`→"/start ", `!esc`→"!esc ". `applyFolder` `/start /op`+`/opt/x`→"/start /opt/x", flag-preserving, and space-path insert `/workdir /srv/My`+`/srv/My Project`→"/workdir /srv/My Project". `recentFolderArgument` `/start /opt/x`→"/opt/x", `/workdir /srv/My Project`→"/srv/My Project", `/start /srv/My Project`→"/srv/My", `/start --claude /a b c`→"/a", `/workdir --claude /a b c`→"/a b c", `/start now`→null, `/start fresh`→null, `!start now`→null, `/start --claude`→null, `/stop /z`→null.

**Acceptance:** all T-1.2 cases green; the regex verified to produce every listed `folderCompletionPartial` result (a `node -e` scratch check or the jest run itself); `tsc` clean.

### T-1.3: `RecentFoldersStore` + `folderSuggestions`

- [ ] `makeRecentFoldersStore(session: Session | undefined): RecentFoldersStore` — localStorage-backed, most-recent-first, cap 15. Key = `matron_journal_recent_start_folders_v1:${encodeURIComponent(session.serverUrl)}:${session.userId}` (same 3-part template as `conversation-flags.ts`).
  - **Parse-don't-validate the stored value (round-1 plan-review Codex M2, P8/P33):** the read parses into a VALIDATED `string[]` — `JSON.parse` in try/catch, then `Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []` — MIRRORING `conversation-flags.ts`'s `parse()`. This makes valid-JSON-wrong-shape (`{}`, `["/srv", 1]`, `null`) degrade to `[]`/skip-non-strings, so downstream `.toLowerCase()`/`.filter()` can never throw on a bad shape.
  - `record(path)`: case-SENSITIVE dedup (move exact match to front), cap 15. **The ENTIRE `record` body is no-throw** (round-1 Codex M2) — wrap read+compute+write so a corrupt store or a `setItem` failure (quota/disabled) both degrade to console.warn, never propagating to the send path that calls it (spec §3.1). Not just the write.
  - `matches(prefix)`: read (validated as above → []), ci prefix filter, most-recent-first, empty prefix → all; whole body no-throw.
  - `session === undefined` → NO-OP store (`record` drops, `matches` → []).
- [ ] `folderSuggestions(input, store): string[]` — call `parseFolderCommand(input)` (the T-1.2 shared helper — NOT a second regex); [] if null; else `store.matches(parsed.partial)`, remove an exact case-SENSITIVE match of `partial`, cap 8. COMMAND-AWARE (round 5 Codex B1): when `parsed.command === "start"`, additionally EXCLUDE any suggestion containing whitespace (a `/workdir`-recorded space path must not be offered under `/start`, where the bridge truncates at `rest[0]`). `workdir` suggestions unfiltered.
- [ ] Tests: store — cs dedup (`/srv/app` after `/srv/App` → 2 entries; exact `/srv/App` twice → 1, front); cap 15 drops oldest; `matches` ci prefix + order; malformed JSON → `matches("")`===[]; **valid-JSON-wrong-shape (round-1 Codex M2): `localStorage` seeded with `"{}"`, `'["/a", 1]'`, `"null"` → `matches("")` returns [] / only the string entries, and `record()` on top of a wrong-shape value does NOT throw**; absent key → []; write-failure (mock `setItem` throw) → `record()` no-throw; undefined session → no-op; round-trip under the `_v1` key. `folderSuggestions` — non-command→[]; case-sensitivity keep-sibling (`/start /srv/App` recents [`/srv/App`,`/srv/app`] → keeps `/srv/app`); cap 8; **command-aware space filter**: `/start /sr` recents [`/srv/My Project`,`/srv/api`] → [`/srv/api`] only; SAME recents under `/workdir /sr` → both.

**Acceptance:** all T-1.3 cases green; `slash-palette-test.ts` full suite green; `tsc` clean; module still JSX/asset-free.

---

## Phase 2 — React component + Composer wiring + styles

Inline in `components.tsx` (no split) + `journal.pcss`. Spec §3.2-3.5.

### T-2.1: `SlashCommandPalette` component (inline in `components.tsx`)

- [ ] **Define the ID contract (round-1 plan-review Codex B1 — these symbols are referenced by both T-2.1 and T-2.2 and must be produced, else TS2304):** a module-level `const SLASH_LISTBOX_ID = "mx_SlashPalette_listbox"` and a helper `const slashRowId = (index: number): string => \`${SLASH_LISTBOX_ID}_opt_${index}\``. Both `SlashCommandPalette` (row `id`, container `id`) and `Composer` (`aria-controls`, `aria-activedescendant`) import/reference these SAME symbols. (A single stable id is fine — only one palette mounts at a time.)
- [ ] Add `SlashCommandPalette` inline (near `Composer`), props `{ commands, folders, highlighted, onHighlight, onSelectCommand, onSelectFolder }` (spec §3.2). Container `id={SLASH_LISTBOX_ID}`; each row `id={slashRowId(index)}`.
- [ ] Render folder rows when `folders.length > 0`, else command rows (trigger monospace + argHint + summary). Each row: `role="option"`, stable `id={rowId(index)}`, `onMouseEnter → onHighlight(index)`, and **selection via `onMouseDown` with `event.preventDefault()`** (NOT onClick — keeps textarea focus / keyboard on mobile; round 5 Codex M2) calling `onSelectCommand`/`onSelectFolder`.
- [ ] Container `role="listbox"` `id={listboxId}`; a `useEffect` keyed on `highlighted` calls `scrollIntoView({ block: "nearest" })` on the highlighted row ref (guarded `highlighted !== null`; round 5/Codex M4).
- [ ] Optional folder-row leading glyph: reuse an existing icon from `icons.tsx` or a simple inline glyph — do NOT import a new SVG asset into any jest-reachable module (component file is fine; keep the pure module clean).

**Acceptance:** `tsc` clean; component compiles; renders folder-vs-command rows by prop; `aria`/`role` attributes present. (Behavior asserted in Phase 3.)

### T-2.2: Composer wiring + keyboard (inline in `components.tsx`, after T-2.1)

- [ ] Add state to `Composer()`: `highlighted` (`number|null`), `dismissed` (`string|null`), `store = useMemo(() => makeRecentFoldersStore(state.session), [state.session])` (spec §3.3).
- [ ] Derive `folders = folderSuggestions(body, store)`, `commands = filterCommands(CLAUDE_BRIDGE_COMMANDS, body)`, `open = body !== dismissed && (folders.length > 0 || (isCommandMode(body) && commands.length > 0))`.
- [ ] Render `<SlashCommandPalette>` above `mx_MessageComposer_row` when `open`, wiring `onHighlight→setHighlighted`, `onSelectCommand`(→ `setBody(applyCommand(trigger)); setHighlighted(null)`; keep focus), `onSelectFolder`(→ `setBody(applyFolder(body,path)); setDismissed(applyFolder(body,path)); setHighlighted(null)`; keep focus).
- [ ] Textarea ARIA (combobox pattern — round 5 Codex M3): `role="combobox"`, `aria-expanded={open}`, `aria-controls={SLASH_LISTBOX_ID}`, `aria-activedescendant={highlighted != null ? slashRowId(highlighted) : undefined}` (the T-2.1 symbols).
- [ ] onChange: after `setBody`, `setHighlighted(null)` and lift dismissal if body changed.
- [ ] Record-on-send: in `send()`, after `if (await client.sendMessage(body))`, `const f = recentFolderArgument(body); if (f) store.record(f);` then clear dismissal. (`store.record` fail-silent → never rejects the send.)
  - **ATTEMPTED-not-confirmed semantics (spec §3.3; re-flagged plan-review round-3 Codex B1 as a P19 check-act concern — accepted, NOT changed):** the boolean gate is client-outbox acceptance, NOT bridge confirmation. A `/workdir /missing` the bridge later rejects (`index.js:4934` "Directory not accessible") is still recorded. This is DELIBERATE and matches apple's `RecentStartFolders` (records on send, pre-outcome) — the journal protocol exposes NO client-visible per-command success/failure signal for `/start`//`workdir` to gate on, so bridge-confirmed recording is infeasible client-side (spec §8 non-goal). Accepted because a rejected path is a harmless, ages-out (cap 15), prefix-gated stale suggestion — never a destructive action. The store's contract is "folders you've LAUNCHED INTO," not "folders that succeeded" (name is descriptive, documented in the module doc). Bridge-confirmed recording would need a new protocol signal → separate future loop, not this feature.
- [ ] Keyboard (`onKeyDown`, spec §3.4) — structure the handler EXACTLY like the repo's own idiom at `components.tsx:2118`:
  - **FIRST line (before any palette or send logic): `if (event.nativeEvent.isComposing || event.keyCode === 229) return;`** — an early `return` WITHOUT `preventDefault` (round-2 plan-review Codex B1). This skips select AND send during IME composition while letting the browser natively COMMIT the composed candidate — `preventDefault` on a composing keydown can cancel the composition/input events (W3C UI Events) and leave stuck/uncommitted text. This mirrors `UploadConfirmPage`'s guard verbatim (the established in-repo idiom; the earlier "swallow via preventDefault" was wrong). Applies whether or not the palette is open.
  - Then, when `open`, the new palette logic OWNS the remaining Enter cases: **plain Enter** (`!shiftKey`) → if `highlighted!=null` `preventDefault`+select (no send), else fall through to existing `send()`; **Shift+Enter** → untouched (native newline → `open` goes false next render); **ArrowUp/Down** → `preventDefault` + move highlight `[0,count-1]` (`count = folders.length || commands.length`); **Tab** → `preventDefault` + select highlighted-or-first; **Escape** → `preventDefault` + `setDismissed(body)` + `setHighlighted(null)`.
  - When `!open`, existing handler unchanged (except the shared IME early-return, which is a strict improvement — the pre-existing send path no longer fires on IME-Enter either).

**Acceptance:** `tsc` clean; `Composer` compiles with all wiring; no change to the `!open` keyboard path; existing `components-test.ts` still green (run it). Behavior asserted in Phase 3.

### T-2.3: Styles

- [ ] **Positioned-ancestor prerequisite (round-1 plan-review M1):** the composer classes (`.mx_MessageComposer`, `.mx_MessageComposer_wrapper`) live in **`src/journal/shell.pcss:436-449`, NOT `journal.pcss`** — and none declares `position: relative`, so an absolutely-positioned palette would resolve against the initial containing block, not the composer. Add `position: relative` to `.mx_MessageComposer_wrapper` (in `shell.pcss`) so the palette's `position: absolute` anchors to it.
- [ ] Add `mx_SlashPalette` (+ row / highlighted / trigger / argHint / summary sub-classes) using `--cpd-*` tokens: `position: absolute; bottom: calc(100% + var(--cpd-space-2x)); left/right` inset to the composer width so it sits ABOVE the composer row (the composer is at the bottom of the viewport → the palette opens upward; `bottom: 100%` is the correct inversion of the existing `.mj_SubagentSwitcherMenu` `top: calc(100% + …)` downward idiom). `max-height: 15rem; overflow-y: auto`, rounded, `--cpd-color-bg-canvas-default` surface, highlighted row uses the existing hover/selected token, monospace trigger, `--cpd-color-text-secondary` argHint/summary. Dark-theme-first. Palette styles + the `position: relative` wrapper rule go where the composer styles live (`shell.pcss`) or `journal.pcss` with `mj_`/`mx_` prefixes — keep them beside the composer rules for cohesion; do NOT split either file.

**Acceptance:** `prettier --check` clean; the palette element has a positioned ancestor (`.mx_MessageComposer_wrapper` is `position: relative`); palette visually positioned above the composer (verified in the Phase 4 build/operator smoke).

---

## Phase 3 — Component integration tests

### T-3.1: Extend `components-test.ts` (cases a-i)

- [ ] **Test-infra prerequisite (round-1 plan-review B1):** jsdom (26.x, per `jest-environment-jsdom@^30`) does NOT implement `HTMLElement.prototype.scrollIntoView` — T-2.1's highlight-scroll effect would throw a `TypeError` inside `act()` and fail every test that moves `highlighted` (b, f, h). Add `Element.prototype.scrollIntoView = jest.fn();` to `test/setup.cjs` (the sole `setupFiles` entry — one line, applies suite-wide) OR a `beforeAll` in the new test block. Verify: without it, T-3.1 cases (b)/(f)/(h) throw; with it, they pass.
- [ ] **Event-dispatch rigor (round-1 plan-review Codex M3):** use a shared helper `keydown(el, key, opts)` that constructs `new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts })` — BOTH flags are required: `bubbles:true` so React's delegated (root-level) handler actually runs, `cancelable:true` so `preventDefault()` has an observable effect. `EventInit` defaults both to `false` (WHATWG DOM), which would let a broken handler pass. For preventDefault-sensitive cases (b/c/f/g), assert on `dispatchEvent`'s return value / `event.defaultPrevented` (false = not prevented) ALONGSIDE the body/send-count invariants. Apply to Enter/Shift+Enter/IME/Arrow/Tab/Escape uniformly.
- [ ] Extend `test/unit-tests/journal/components-test.ts` (reuse the `createRoot`/`act` + `jest.mock` SVG harness; dispatch via the `keydown` helper above; mouse via `MouseEvent{bubbles,cancelable}`). Cases from spec §5: (a) type `/st` → palette opens with command rows; (b) ArrowDown highlights row 0, Enter selects → body `/start `, no send; (c) Shift+Enter with a row highlighted → handler does NOT preventDefault/select/send (jsdom-provable no-op); (d) Enter, no highlight → sends literal text; (e) Escape → palette gone, body unchanged; (f) Tab → completes first row; (g) IME Enter (`isComposing:true` / `keyCode:229`) → selects nothing, sends nothing, AND `event.defaultPrevented === false` (the handler must NOT cancel the composing keydown — round-2 plan-review Codex B1); (h) folder path: seed store with `/srv/Project`, type `/workdir /srv/P` → folder rows render, **click-select** (dispatch a `click`; selection now lives on `onClick`, with `onMouseDown`→`preventDefault` for focus retention — Phase-2-review a11y fix) → body `/workdir /srv/Project` (correct `onSelectFolder`, fires exactly once), `onMouseEnter` updates highlight, AND assert the mocked `scrollIntoView` was called when highlight moved (round-1 Codex M1 — proves the effect fires, not just that it doesn't throw); (i) recording gate (round-3 plan-review Codex M2 — use DISTINCT paths + a whole-store snapshot so an unconditional-recording bug can't hide behind dedup): `sendMessage` mock → true, send `/workdir /op/accepted` → assert store now contains `/op/accepted`; THEN mock → false, send `/workdir /op/rejected` → assert `/op/rejected` is ABSENT and the full store contents are byte-identical to the pre-send snapshot (not merely "no new dedup'd entry"). Reusing one path would let a record-on-every-send defect pass via exact-dedup.

**Acceptance:** all (a)-(i) green; full `jest` suite green (no regression in existing tests).

---

## Phase 4 — Verify gate (+ operator-gated deploy prep)

### T-4.1: Full verify

- [ ] Run in the worktree: `corepack pnpm lint:types` (tsc), `corepack pnpm test` (jest, runInBand), `corepack pnpm lint` (tsc + prettier check), `corepack pnpm build` (webpack production → `webapp/`). All must pass.
- [ ] Confirm no split of `components.tsx`/`client.ts`. Expected diff surface (round-2 plan-review Codex B3): additions to `components.tsx` (component + wiring), NEW `src/journal/slash-palette.ts`, NEW `test/unit-tests/journal/slash-palette-test.ts`, extended `test/unit-tests/journal/components-test.ts`, one line in `test/setup.cjs` (scrollIntoView polyfill), and additions to `shell.pcss` (composer `position: relative` + palette styles) and/or `journal.pcss`. `shell.pcss` IS expected — do NOT reject it (it holds the composer classes). No file split.
- [ ] Deploy is OPERATOR-GATED and NOT an execution task — per spec §6, the operator runs the CLAUDE.local.md web-deploy runbook and the feature-specific smoke checks. This task stops at "build green + verify clean"; it does NOT swap `/opt/matron/web-journal/webapp` or push.

**Acceptance:** all four `pnpm` gates pass; diff respects the no-split constraint; build produces `webapp/index.html`. Branch left ready for operator-gated deploy + push + PR.

---

## Spec-coverage map

| Spec part | Task(s) |
|---|---|
| §2.1 catalog (22 entries, verbatim !help) | T-1.1 |
| §3.1 filterCommands/isCommandMode (ws-strip) | T-1.1 |
| §3.1 folderCompletionPartial / applyCommand / applyFolder | T-1.2 |
| §3.1 recentFolderArgument (command-specific + sentinels) | T-1.2 |
| §3.1 RecentFoldersStore (cs dedup, fail-silent, _v1, no-op) | T-1.3 |
| §3.1 folderSuggestions (cs exclude, cap 8, command-aware space filter) | T-1.3 |
| §3.2 SlashCommandPalette (rows, ARIA, mousedown-select, scroll-into-view) | T-2.1 |
| §3.3 Composer wiring (state, open-derivation, select, record-on-send) | T-2.2 |
| §3.4 keyboard (Enter/IME/Shift+Enter/Arrow/Tab/Escape ownership) | T-2.2 |
| §3.5 styles | T-2.3 |
| §5 pure unit tests | T-1.1, T-1.2, T-1.3 |
| §5 committed component tests (a)-(i) | T-3.1 |
| §6 deploy (operator-gated; verify only) | T-4.1 |
| §7 follow-ups | out of scope (documented) |

Every spec §2-§6 part maps to ≥1 task. §7 (follow-ups: /context-/compact, config-driven catalog, upstream proposal, catalog-drift) and §9 (grounding appendix) are intentionally out of execution scope.

## Principles pass (against docs/universal-design-principles.md)

- **P2 canonical source:** catalog carries the source-pointer comment; §7 tracks the config-driven fix. Store key reuses the existing 3-part template (no divergent key builder). ✓
- **P3 fail-visible:** store reads AND writes wrapped (degrade, console.warn, never throw); palette hides on zero command match rather than showing empty. ✓
- **P5 don't mirror external state in React:** `highlighted` is single-owned by `Composer`; the palette reads it via prop + reports hover via `onHighlight` (no duplicate state). Scroll uses a ref + effect keyed on `highlighted`. ✓
- **P7 verify APIs against source:** bridge `/start` vs `/workdir` grammar, sentinels, prefix acceptance, no-`--worktree` all read from `bridge-journal/index.js` (grounding block). ✓
- **P8 guard boundary inputs:** the composer string is parsed into typed intent at one boundary; localStorage reads guarded. ✓
- **P16/P18 deletion/cognitive budget:** heavy logic in the ~200-250-line `slash-palette.ts`; component inline is thin. The P18 tension (components.tsx ~2273 lines) is operator-accepted (no-split constraint) and tracked as loop #448 — deliberate exception. ✓
- **R102 (BLOCK):** no destructive commands in the execution tasks; deploy/rollback is operator-gated and de-scoped to the owned runbook (mv-preferred rollback). ✓

No new principle violations introduced; the one deliberate exception (P18 inline vs no-split) is operator-decided and tracked.

## Rollback

Pure client-side, additive, unreleased branch. Rollback of the WORK = discard the `feat/slash-palette` branch (nothing merged/deployed until operator gates). Rollback of a bad DEPLOY = operator restores the `webapp.bak.<ts>` per the runbook (spec §6). No data migration, no server state, no irreversible action in any execution task.

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

## Appendix: Verified Claims (research pass 2026-07-21)

Automated Tavily batch was unavailable (no API key); claims verified via WebSearch (W3C/authoritative) + the repo's own existing usage.

✓ **aria-activedescendant ownership (T-2.1/T-2.2).** In the WAI-ARIA combobox pattern, DOM focus stays on the textbox and `aria-activedescendant` is set ON THE TEXTBOX referencing the active listbox option — NOT on the listbox. Verified: W3C WAI-ARIA APG Combobox Pattern (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/). The SAME source confirms the plan's scroll-into-view need: "browsers do not manage visibility of elements referenced by aria-activedescendant... the JavaScript scrolls the option referenced by aria-activedescendant into view" — validates T-2.1's `scrollIntoView({block:"nearest"})`.

✓ **mousedown + preventDefault keeps the textarea focused (T-2.1).** blur fires after mousedown and before mouseup; calling `preventDefault()` in the mousedown handler prevents the browser from moving focus, so an option selected on mousedown keeps the input focused (and the mobile keyboard open). Verified: event-order references (codepen mudassir0909/qBjvzL; dev.to preventDefault/stopPropagation deepdive) + Radix/focus-trap notes. Caveat: focus-trap libraries (radix-ui focus-scope, focus-trap-react) can intercept — N/A here, the journal composer is not inside a focus trap.

✓ **IME-commit Enter detection (T-2.2).** A keydown Enter during IME composition carries `keyCode === 229` and `event.isComposing === true` — the standard ignore-IME-Enter guard. Verified against the repo's OWN existing usage: `components.tsx:2119` (`UploadConfirmPage` caption) already uses `event.nativeEvent.isComposing || event.keyCode === 229`. The plan reuses this established in-repo idiom.

✓ **jsdom cannot observe native newline insertion (T-3.1 case c).** jsdom does not perform the browser's trusted default textarea-editing action for a synthetically dispatched keydown, so a jest/jsdom test cannot assert native newline insertion from a dispatched Shift+Enter. This is why T-3.1 case (c) asserts only the jsdom-provable contract (handler does not preventDefault / select / send) — established jsdom limitation, and the reason the spec (round 2 Codex M2) reworded that assertion.
