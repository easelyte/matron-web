# from-coding-agent (v6)

These are the results of implementing redesign v6 in `easelyte/matron-web`. They cover the auto-diff (HANDOFF §3 step 9), what the implementation found about the bridge, and where it departed from the package.

## Auto-diff

- **How it was run:** `scripts/visual/probe-v6.mjs` runs `tools/probe.js` twice for each state, in both themes:
  - on the prototype (`Matron Redesign v6.html#state=…`, design mode);
  - on the live fixtures build (`?v6=…`, live mode with `window.MAP = component-map.json`).
- **Result:** 15 paired states, 490 compared properties, **406 within tolerance**. The per-property deltas are in `diff.json`.
- **Why the rest differ:** every remaining delta is a selector-granularity mismatch, not a visual difference. The design puts `data-spec` on a wrapper, while the map's `suggested` selector points at the control inside it:

| spec | design specimen | live selector (map) |
|---|---|---|
| `turn.card.group` | `.mj_TurnCard_group` (wrapper) | `.mj_TurnCard_group > .mj_TurnCard_groupRow` |
| `turn.card.changedFiles` | `.mj_TurnCard_changed` (block) | `.mj_TurnCard_changed > .mj_TurnCard_file` |
| `turn.card.deep.command` | `.mj_TurnCard_deep` (panel) | same panel; font inherits from a different ancestor chain |
| `modal.newSessionOptions.{agent,model,browser,firstTask}` | `.mj_Field` wrapper | the control (`.mj_Segmented`, `select.mj_Select`, the switch, `textarea`) |

For the next round, either put `data-spec` on the control, or change the map's `suggested` to the wrapper.

**Fixed as a result of the diff:** the split button was 36px tall because live has no global `border-box`. It is now 34px.

**Inter 500:** it now ships from `@fontsource/inter/latin-500.css`. The fixture build loads 400, 500 and 600. Before this, 500 was matched to 400.

The large `probe-design.json` and `probe-live.json` dumps are not committed; the script above regenerates them. Screenshots come from `scripts/visual/shoot-v6.mjs` and are not committed.

## What the bridge does not provide yet

The client works around each of these today. What follows is what would make each surface exact.

1. **Steps.** For Claude, only Bash commands (`tool_output`, published when the command completes) and Edit/Write/MultiEdit (`diff`) reach the journal. Read, Grep, Glob, WebFetch, WebSearch and Task produce no durable event, so the card under-counts (turn 1 in the fixtures has to use `cat`/`rg` to show look and search groups). Codex publishes command_execution and file_change/apply_patch. **Needed:** a durable per-step event (`tool_name`, an input summary with path/pattern/url/description, status, start and end timestamps) for every tool use.
2. **Live line.** Claude publishes `activity: tool` only for Bash, so while a Read is running the line reads "Thinking…". There is no step start time either, so the elapsed and slow timers start from when the client first saw the step. **Needed:** activity details for every tool, and a `started_at` on `tool_stream` meta and on activity.
3. **Stop.** There is no interrupt-the-current-step command (`/stop` ends the session), so the slow state shows amber but no Stop button. **Needed:** a `/interrupt` command, or an RPC.
4. **System notices and turn errors** are plain agent `text`. The client recognises them by the bridge's exact wordings. **Needed:** a `payload.notice` kind, e.g. `compacted | idle_resume | queue_flush | restart_queued | restarting | restarted | session_ended | resume_failed`, plus `payload.error` for turn-ending errors.
5. **Browser tools.** There are no queued, restarting or on events. The client reads the operator's `/restart --browser` and the replies "Waiting for turn to finish before restarting", "🔄 Restarting …" and "… session restarted.\nExtras: browser". **Needed:**
   - a structured restart lifecycle event;
   - the session's MCP extras on `session_status`;
   - the extras reported for `/start` and for RPC `start`, which today never say whether browser tools are on;
   - optionally, a per-box memory figure instead of the fixed 400 MB.
6. **One-tap defaults.** `recent_folders` returns `model_options`, `default_model` (only when `MATRON_DEFAULT_MODEL` is set), `agent_options` and `default_agent`, but no **`default_folder`**, and `hello` carries none of these. So the split button's hint appears only after the operator saves defaults. **Needed:** `default_folder` (the bridge's `defaultWorkdir`) in the `recent_folders` reply, and ideally the same fields in `hello`.

## Deliberate departures

- **Design round 2 (accepted by the operator):**
  - Show the work is labelled **Developer view**.
  - Settings is the sliders icon, last in the sidebar header, with no sidebar footer; it becomes a bottom sheet on the phone.
  - Theme moves into the Settings menu.
  - There are no descriptive hint lines. A hint appears only as the reason something is disabled.
- **Typing indicator:** it still shows while a running turn has no card yet (the agent is thinking before its first step). Without it, a new turn would show nothing at all.
- **Answering a prompt** (`prompt_reply`) does not open a new turn. An answer the prompt card already shows as a picked option is not repeated.
- **Codex sessions** keep browser tools disabled, as the design specifies, even though the Codex app-server transport can load MCP extras.
