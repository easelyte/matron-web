# Agent-Spawn Consent Card Implementation Plan (matron-web)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `agent_spawn` consent cards, answer them over `POST /agent-spawn/answer`, and reflect the journaled `spawn_outcome` resolution with an Open deep-link.

**Architecture:** New `AgentSpawnCard` in the `PromptCard` family (`src/journal/components.tsx`), a `spawnOutcomes` memo deriving resolution from journaled events, one typed REST method on `JournalApi` + a `client` passthrough, and a minimal `spawn_outcome` timeline row. Spec: `docs/superpowers/specs/2026-08-11-agent-spawn-card-design.md` (read it first — it is the requirements source).

**Tech Stack:** React 19 + TypeScript, hand-rolled external store (`client.ts` + `useSyncExternalStore`), plain PostCSS (`journal.pcss`, `mj_` classes), Jest 30 + jsdom (no RTL — `createRoot` + `act` + `querySelector`).

## Global Constraints

- The card resolves ONLY on the durable `spawn_outcome` event — never optimistically on tap (mirror `PromptCard`'s `permission` path: pending → durable, `PROMPT_REPLY_CONFIRMATION_TIMEOUT_MS`-style retry affordance).
- The answer body is EXACTLY `{request_id, decision}` — a test asserts the POST body keys; `always_allow` must never appear.
- Unanswerable card payloads (non-string/empty `request_id` or `task`) fall back to the existing generic `PromptCard` rendering — never a card with buttons that would 400.
- No local persistence of answered-state (no localStorage/IndexedDB writes for it) — the journal event is the record.
- Never crash on unknown `outcome` values — neutral "Spawn request resolved" copy.
- Match house style: module-level `css` not used here (this repo uses `journal.pcss` classes — add `mj_PromptCard_spawn` rules beside `mj_PromptCard_permission` ~`journal.pcss:2519`); single quotes; existing `mj_` BEM-ish naming.
- Verification: `pnpm test` (Jest, `--runInBand`) and `pnpm lint` (tsc + prettier) must both pass; CI runs exactly these.
- Commits: `feat(spawn): …` / `test(spawn): …`, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

**Anchors (from repo survey, verify against the live file):** `EventContent` switch `components.tsx:3098`, `permission_request` case `:3139`, `PromptCard` `:2462`, `answeredPromptReplies` memo `:3486`, prompt-case keying `:3131`, `PROMPT_AFFIRMATIVE` `:2649`, `eventSnippet` `types.ts:457`, `JournalApi` private `json()` `api.ts:257`, `selectConversation` `client.ts:465`, `sendPromptReply` `client.ts:1115`, permission-card tests `test/unit-tests/journal/components-test.ts:259` (payload factory `:262`), diff-card precedent `diff-card-test.ts`.

---

### Task 1: Card + outcome row + resolution derivation (render-only)

**Files:**
- Modify: `src/journal/components.tsx` (AgentSpawnCard, spawn_outcome case, dispatch, spawnOutcomes memo, prop threading)
- Modify: `src/journal/types.ts` (`eventSnippet` mapping)
- Modify: `src/journal/journal.pcss` (`mj_PromptCard_spawn` modifier, monospace task block, resolved-state styles)
- Test: `test/unit-tests/journal/agent-spawn-card-test.ts` (new file, registered by the existing glob)

**Interfaces:**
- Produces: `AgentSpawnCard({event, outcome, onAnswer?, onOpen?})` component where `outcome` is the matched `spawn_outcome` payload or `null`; `spawnOutcomes: Map<string, SpawnOutcomePayload>` memo passed down through `EventRow`→`EventContent` exactly like `answeredPromptReplies` (`:3110`). In Task 1 `onAnswer` is wired to a no-op prop; Task 2 supplies the real one.
- Consumes: `ClientState.events` via the same component-tree props as `answeredPromptReplies`.

- [ ] **Step 1: Write failing tests** — new `agent-spawn-card-test.ts` using `signedInClient()`/`renderClient()` from `components-test.ts` (import or replicate its harness helpers per that file's pattern). A payload factory mirroring the journal's minted card:

```ts
const spawnCardEvent = (over: Record<string, unknown> = {}) => ({
    seq: 40, convo_id: "c1", ts: 1700000000, sender: "agent:dev-6",
    type: "permission_request",
    payload: {
        kind: "agent_spawn", request_id: "spawn-1",
        from_device_id: 7, from_name: "dev-6",
        from_convo_id: "c1", from_convo_title: "Fix the flaky tests",
        target_device_id: 12, target_name: "eric",
        workdir: "/home/dan/proj", task: "Run the suite and fix flakes",
        topic: "Flake hunt", ...over,
    },
});
const spawnOutcomeEvent = (outcome: string, extra: Record<string, unknown> = {}, seq = 41) => ({
    seq, convo_id: "c1", ts: 1700000100, sender: "journal",
    type: "spawn_outcome", payload: { request_id: "spawn-1", outcome, ...extra },
});
```

Cases: renders card (headline "Flake hunt", target "eric", workdir row, verbatim task text, Deny+Approve buttons); topic absent → headline from task; missing `request_id` → falls back to generic permission card (assert `mj_PromptCard_permission` present and no spawn class); with `spawnOutcomeEvent("started", {room_id: "r1", child_convo_id: "cc1"})` in events → no buttons, "Started" + Open button; declined → "Denied"; expired → "Expired"; failed + error_code → "Failed — boom"; unknown outcome → "Spawn request resolved"; standalone outcome row renders its status line (each outcome) and started row has Open; `eventSnippet` returns the four snippet strings and neutral fallback.

- [ ] **Step 2: Run, verify fail** — `pnpm test -- agent-spawn-card`
- [ ] **Step 3: Implement** — `AgentSpawnCard` beside `PromptCard`; `spawnOutcomes` memo beside `answeredPromptReplies` (`useMemo` scanning `state.events` for `type === "spawn_outcome"`, keyed by `String(payload.request_id)`); dispatch inside the `permission_request` case: `payload.kind === "agent_spawn"` AND answerable → spawn card (keyed `${event.convo_id}:${event.seq}`), else existing behavior; new `case "spawn_outcome"` status row; `eventSnippet` mapping; pcss rules.
- [ ] **Step 4: Run tests + lint** — `pnpm test -- agent-spawn-card`, then full `pnpm test` and `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(spawn): render agent_spawn consent cards and journaled outcomes`

---

### Task 2: Answer flow + deep-link

**Files:**
- Modify: `src/journal/api.ts` (`answerAgentSpawn`), `src/journal/client.ts` (passthrough), `src/journal/components.tsx` (wire onAnswer/onOpen, pending/409/404/retry states)
- Test: extend `test/unit-tests/journal/agent-spawn-card-test.ts`

**Interfaces:**
- Produces: `JournalApi.answerAgentSpawn(requestId: string, decision: "approve" | "deny"): Promise<void>` (on the private `json()` helper, POST `/agent-spawn/answer`, body `{request_id, decision}`); `client.answerAgentSpawn(requestId, decision): Promise<void>` passthrough that rethrows `JournalApiError`.
- Consumes: Task 1's card and memo; `client.selectConversation(roomId, {fromRpcCreate: true})` for Open.

- [ ] **Step 1: Write failing tests** — approve tap → "Sending…" and card NOT resolved while no event; durable event arrival resolves to Started+Open; deny tap → same pending flow; api error with `.status === 409` → immediate resolved-expired copy "Already answered or expired"; `.status === 404` → "That request is no longer on the server."; transport error → card back to answerable with retry copy; POST body assertion: exactly `{request_id, decision}` keys (spy on fetch or the api method per the harness's existing stubbing approach); Open button calls `selectConversation` with `("r1", {fromRpcCreate: true})` (stub via the harness's client internals pattern); **stale-completion test (PR #23, Bugbot + CodeRabbit)**: attempt A times out → attempt B starts while A's POST is still in flight → A rejects late (transport error) → B must remain `sending`, buttons stay disabled, no state overwrite; cover the same shape with A settling late via a `409` too — either way A settles, it must not clobber B (control both attempts' promise settlement independently, e.g. a manually-resolvable deferred pair per attempt, so the test can sequence "B starts" before "A settles").
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement** — api method + client passthrough; card local state machine (`idle → sending → {waiting-durable | resolved-409 | error-retryable}`) mirroring `PromptCard`'s permission flow incl. its confirmation-timeout treatment; guard every phase transition (the confirmation-timeout callback and every promise-settlement handler) behind a monotonically increasing attempt-id ref so a late-settling stale attempt can never overwrite a newer one's `sending` state; wire Open on card + outcome row.
- [ ] **Step 4: Full verification** — `pnpm test` and `pnpm lint`, all green.
- [ ] **Step 5: Commit** — `feat(spawn): answer spawn asks and deep-link into the spawned room`
