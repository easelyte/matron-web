# Fixtures, mocks, contracts and open decisions

## Fixtures (design-side only)

`src/model.js → fixtures`: six turns plus a 210-step stress turn, a peer message, and four bridge notices. These are redacted stand-ins shaped like real journals. **None of their strings are product copy**: step sentences and live lines come from client templates, narration comes from the agent, and answers come from the agent.

| Fixture | Shape |
|---|---|
| T1 done | narration + 11 steps (4 reads over 3 files, 2 searches, git log, 1 edit +18 −6, tests pass, tsc exit 2 → tsc exit 0) + 3-paragraph answer with a file link |
| T2 running | 6 steps done; live line script `Reading journal-rpc.js…` → `Searching for default_model…` → `Running the tests…` (elapsed from 30s) |
| T3 waiting | 2 steps, then a permission request `Allow: push the fix branch?` blocks the turn; later a question card |
| T4 done | 3 steps; break-throughs: image, PDF, tracker item #302 |
| T5 error | tests fail, `Asked a helper: triage failing tests`, helper-started row, then `The session couldn’t resume. Send a message to start fresh.` |
| T6 | plain Q&A, no steps, no card |
| T210 | 140 reads over 96 files, 30 searches, 12 edits, 8 test runs (2 failures), 6 tsc (1 failure), 6 other commands, 6 git, 2 helpers, 3 narrations |

## Contracts

1. **Live line and step sentences** come from the client's templates (GENERATIVE-SYSTEM §1 table) applied to journal events, plus the agent's own narration. The design never supplies them. Templates live in the client, next to the grouping code.
2. **Activity grouping** follows the rules in GENERATIVE-SYSTEM §1. They are a proposal, and `src/model.js → CLASSES / groupTurn()` is the reference implementation. Changes to the rules should update that table.
3. **Enable browser tools** sends the bridge's `/restart --browser`. It keeps the conversation and waits for the current turn to finish unless forced. **Restart now** is the forced variant: it stops the current step. The client shows *queued* (header chip) until the bridge reports the restart, then *restarting* (system notice), then *on*. States must be driven by bridge events, not timers (the mock uses timers).
4. **One-tap New session** starts with the default folder, default model and default agent, browser tools off, and no first message. "Defaults" are the box's defaults unless the operator ticked **Remember as my defaults**, in which case they are the operator's stored choice (client-side, per box).
5. **First task** is sent as the first ordinary operator message after the session starts. It is not a special payload.
6. **Show the work** is a per-operator client preference (suggested key `matron.showTheWork`, default `false`). ON renders today's thread unchanged.
7. **"That folder doesn’t exist on the box."** comes from the bridge's start error. The client doesn't pre-validate paths.
8. **Uncertain start** ("May have started. Check your list") is shown when the start RPC times out without a result. It is never retried automatically.

## Mocks in the artifact (not behaviour)

- Timers drive turn 2's live line, the 1.5s "Starting…", and the browser-tools restart sequence.
- The image is a striped stand-in (`.mv6_ImageStandIn`), and the tracker item is a stand-in (`.mv6_ItemCardStandIn`). Use the real components.
- "Open helper", "Load full output", "Check your list", Sign out, Rename/Pin/Archive are inert.

## Open decisions

1. Accent-as-text contrast in light (`#0d9488` ≈ 3.6:1). Proposal: `--cpd-color-bg-accent` for text in light.
2. Which gear anchors the Settings menu (live `.mj_AccountMenu` is top-right; the brief says the sidebar gear).
3. Codex tool-name mapping for grouping.
4. Whether the changed-file deep view should show one diff per path (drawn) or all diffs for that path concatenated.
5. Where turn duration starts (drawn: at the operator message).

## Do not implement

- `data-spec="devtool.stateMatrix"`: the dashed **states** button + panel (`.mv6-dev*`), which exists only to reach states by clicking.
- `.is-hover` / `.is-focus` classes. They force pseudo-states in static exports. Implement `:hover` / `:focus-visible` only.
- `.mj_TurnCard_liveText.is-mid`, the frozen mid-cross-fade used by one static state.
- `.mv6-phone`, `.mv6-narrowStage`: presentation frames.
- `.mv6_*StandIn` classes.
- `tools/probe.js`, `tools/export.js`, `census.json`: tooling.
- Hash routing (`#state=…&theme=…`) in the artifact.
