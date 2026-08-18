# Agent-spawn consent card — design (matron-web)

**Date:** 2026-08-11
**Status:** approved (Dan, 2026-08-11 — campaign design approved in session; this doc is the web slice)
**Depends on:** matron-journal `spawn_outcome` events (specs/2026-08-11-spawn-outcome-events-design.md in matron-journal) and the merged agent-spawn protocol (matron-journal docs/protocol.md, "Agent-spawned sessions").

## Goal

Render the journal's `agent_spawn` consent card in the timeline, let the user
Approve/Deny via `POST /agent-spawn/answer`, and reflect the durable
resolution — including an "Open" link into the spawned room. Without this the
web client shows spawn asks as a broken generic permission card whose buttons
send a useless `prompt_reply`.

## What the wire gives us

- **Card:** `permission_request` event, `payload.kind: 'agent_spawn'`, payload
  `{request_id, from_device_id, from_name, from_convo_id, from_convo_title,
  target_device_id, target_name, workdir, task, topic?}` — appended into the
  parent conversation (the one being viewed). All strings server-sanitised.
- **Resolution:** `spawn_outcome` event in the SAME conversation, payload
  `{request_id, outcome: started|declined|expired|failed, room_id?
  (started), child_convo_id? (started), error_code? (failed)}`.
- **Answer:** `POST /agent-spawn/answer` `{request_id, decision:
  'approve'|'deny'}` → 200 `{ok:true}`; 409 = already resolved (elsewhere, or
  expired); 404 = row gone; any `always_allow` key = 400. Client-token only.

## Design

### Kind dispatch and components

In `EventContent`'s `permission_request` case (`components.tsx` ~3139): when
`payload.kind === 'agent_spawn'`, render the new `AgentSpawnCard` instead of
`PromptCard` — but only when the payload is answerable (string `request_id`,
non-empty `task`); otherwise fall through to the existing `PromptCard` path,
mirroring the parse-or-fallback rule the native clients use for agent-chat.
Keyed `${event.convo_id}:${event.seq}` like the prompt cases.

`AgentSpawnCard` joins the `.mj_PromptCard` family (same row structure so
answering doesn't reflow; new modifier class `mj_PromptCard_spawn`). Content:

- Header label "Agent spawn request".
- Headline: `topic` when present, else first line of `task` (CSS-truncated).
- Detail rows: From (`from_convo_title` + `from_name`), Target
  (`target_name`), Folder (`workdir`), and the full `task` verbatim in a
  monospace block — the text shown is the text that runs.
- Action row: Deny (plain) + Approve (filled) — fixed order, no options
  array, no always-allow anything.
- Resolved states (replaces action row): `started` → "Started" + an **Open
  button** navigating to `outcome.room_id`; `declined` → "Denied"; `expired`
  → "Expired"; `failed` → "Failed — <error_code>".

### Resolution state (durable, derived — no local persistence)

A `spawnOutcomes` memo beside `answeredPromptReplies` (`components.tsx`
~3486): scan `state.events` for `type === 'spawn_outcome'`, map
`payload.request_id → payload`. A card whose `request_id` has an entry is
resolved — across restarts and devices, because the event is journaled.

In-flight state is component-local and strict like the permission path: a tap
sets `pending` ("Sending…"); the card resolves ONLY when the durable event
arrives. On a `409` reply, flip to resolved-`expired` style immediately with
copy "Already answered or expired" (the durable event follows via sync and
takes over). On `404`: "That request is no longer on the server." On
transport error: back to answerable with the retry affordance, mirroring
`PromptCard`'s `retryable` treatment and its 10s confirmation timeout.

**Attempt-identity guard (required, not optional).** A tap's own POST and the
10s confirmation timeout can both still be outstanding after the user retries
— attempt A's request can settle (fulfilled or rejected) after attempt B has
already started. Every phase transition — the confirmation-timeout callback
AND every promise-settlement handler (success and failure) — MUST be gated on
a monotonically increasing attempt id (a ref counter, bumped once per tap):
capture the id when the attempt starts, and apply the resulting phase change
only if that captured id still equals the current counter value. Without this
guard, a late-settling A can silently overwrite B's `sending` with a stale
`retryable`/`already-answered`/`gone`, re-enabling Approve/Deny while B is
still in flight and inviting a duplicate POST (found by Bugbot + CodeRabbit on
PR #23, both independently, as a promoted "deferred minor"). The
promise-settlement handlers are additionally gated on a mount-tracking ref
(mirrors the new-session sheet's `agentsRequestIdRef`/`mountedRef` pattern in
`components.tsx`) — the setTimeout path doesn't need that half, since its own
cleanup already cancels it on unmount.

### The answer call — first client-initiated REST POST

`JournalApi` gains a public, typed method (keeping `request()` private):

```ts
async answerAgentSpawn(requestId: string, decision: "approve" | "deny"): Promise<void>
```

implemented on the existing private `json()` helper, POSTing
`/agent-spawn/answer`. Errors surface as the existing `JournalApiError`
(status 409/404 distinguishable by `.status`). The card calls it via a new
`client.answerAgentSpawn(...)` passthrough so components keep talking to the
client, not the api (house pattern).

### Timeline rendering of `spawn_outcome` itself

A minimal `case "spawn_outcome"` in `EventContent`: one status line reusing
the snippet strings ("🚀 Spawned session started" / "🚫 Spawn declined" /
"⌛ Spawn request expired" / "❌ Spawn failed — <code>"), `started` variant
carrying the same Open link. This keeps the durable record legible when the
card has scrolled away and stops the `<details>` JSON dump the default case
would show. `eventSnippet` (`types.ts` ~457) gains the same mapping so the
sidebar row reads correctly.

### Open / deep-link

Open (on the card and the outcome row) calls
`client.selectConversation(room_id, { fromRpcCreate: true })` — the existing
navigate-to-a-conversation-the-server-may-not-have-materialised path with its
watchdog and suppressed-404 history load.

### Out of scope

- Agent-chat consent cards for web (same pattern, separate campaign — noted
  gap: today they render as a broken generic prompt).
- `capabilities` gating: the card only appears if the journal minted it, so
  no capability check is needed.

## Error handling

Covered above: 409 → resolved-expired copy; 404 → gone copy; transport →
retryable; malformed payload → generic PromptCard fallback; unknown
`outcome` value in a `spawn_outcome` event → render as plain "Spawn request
resolved" (never crash).

## Testing

Jest (`test/unit-tests/journal/components-test.ts` conventions — `createRoot`
+ `act` + `mj_` class queries, `signedInClient()` harness):

- Dispatch: `agent_spawn` payload renders `AgentSpawnCard`; unanswerable
  payload (missing `request_id`) falls back to `PromptCard`; kind
  `queued_release` untouched.
- Content: headline prefers `topic`; task shown verbatim; workdir/target
  rows present.
- Answer flow: tap Approve → pending, card does NOT resolve optimistically;
  durable `spawn_outcome` event arriving in `state.events` resolves it
  (started shows Open, declined shows Denied).
- 409 → resolved-expired copy; 404 → gone copy; transport error → retryable.
- `always_allow` is never sent (assert the POST body keys exactly).
- Outcome row: each outcome renders its status line; started row has Open;
  unknown outcome renders the neutral copy.
- `eventSnippet` mapping.
- Identity reset across `${convo_id}:${seq}` (reuse the existing test's
  shape).
