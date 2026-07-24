# Plan — matron-web redesign v3 reskin port (#497)

**Spec:** `docs/superpowers/specs/2026-07-24-web-redesign-v3-reskin-design.md` (reviewed, spec-review converged round 5)
**Repo:** easelyte/matron-web (`/opt/matron/web-journal`)
**Branch:** `vps-redesign-v3-reskin` (already created)
**Risk:** medium — live-client deploy (operator-gated, atomic), but all code changes are CSS + additive presentational markup; no logic/data-flow changes.
**Serialize:** loop #448 — single window; this is the only session touching `components.tsx`/`client.ts`.

Approach B + operator decision (a): faithful v3 reskin, CSS-heavy / TSX-light (additive presentational markup + placement conditionals only). Every new *behavior* stays deferred (#498-503, #470).

## Dependency graph
- **Phase 1 (tokens)** blocks everything — all component work references the new/flipped tokens.
- **Phase 2 (message model)**, **Phase 3 (cards)**, **Phase 4 (composer/header/sidebar)** each depend on Phase 1; they are logically independent but **executed sequentially** (SERIALIZE — same files `shell.pcss`/`journal.pcss`/`components.tsx`).
- **Phase 5 (verify + deploy)** depends on Phases 1-4 complete.

## Spec-coverage map (AC → tasks)
AC1 → T-2.1/T-2.2/T-2.3/T-2.4 (+ T-2.5 regression ratchet) · AC2 → T-3.1 · AC3 → T-3.2 · AC4 → T-3.3 · AC5 → T-1.3 · AC6 → T-4.1 · AC7 → T-1.2 · AC8 → T-2.2/T-2.3/T-3.1/T-4.1 (additive-nodes audit) · AC9 → cross-cutting (T-4.2, no deferred-feature DOM) · AC10 → T-5.1..T-5.5.

**CSS-citation grounding (round-1 Codex M5, P35):** all `shell.pcss`/`journal.pcss` selectors + line coordinates in this plan were grep-confirmed against HEAD during authoring (the spec-review rounds read both files live). Execution should re-grep before editing per P35, but the citations are not memory-derived.

---

## Phase 1 — Design tokens & theme foundation

### T-1.1: Add the three new tokens + inventory note
- [ ] In `shell.pcss` `:root`: add `--cpd-color-bg-diff-add: rgb(52 199 89 / 0.13);` `--cpd-color-bg-diff-del: rgb(255 59 48 / 0.09);` and `--cpd-color-text-on-badge: #fff;`.
- [ ] In `[data-theme="dark"]`: add `--cpd-color-bg-diff-add: rgb(52 199 89 / 0.12);` `--cpd-color-bg-diff-del: rgb(255 107 107 / 0.10);` (keep `--cpd-color-text-on-badge: #fff`).
- **Acceptance:** three new tokens present in both blocks with the spec values; `corepack pnpm build` clean.

### T-1.2: Dark on-accent flip + decouple login-submit & badge (contrast-verified)
- [ ] `[data-theme="dark"] --cpd-color-text-on-accent: #0b201c;` (was `#f5f7fa`).
- [ ] `.mj_UnreadBadge` (shell.pcss:390-398): `color: var(--cpd-color-text-on-badge);` (not on-accent).
- [ ] `.mx_Login_submit` (shell.pcss:796-800): add explicit `color` that stays light in dark (e.g. keep `#f5f7fa` via a dedicated rule or `[data-theme="dark"] .mx_Login_submit { color: #f5f7fa; }`) — its bg is `--cpd-color-bg-accent` `#0f766e` (deep), where `#0b201c` = 3.10:1 fails.
- [ ] Compute-verify (WCAG) all on-accent consumers both themes: send circle + upload-send (`#0b201c` on `#14b8a6` ≈ 6.8:1 ✓), login-submit (`#f5f7fa` on `#0f766e` ≈ 5.1:1 ✓), badge (`#fff` on `#7d756b` ≈ 4.53:1 ✓ light / on `#3a3f46` ≈ 10.6:1 ✓ dark).
- **Acceptance:** AC#7 — every on-accent surface passes WCAG AA in both themes, numbers recorded in the deploy manifest.

### T-1.3: Dark-theme syntax highlighting block
- [ ] Add a `[data-theme="dark"]` override block for `.hljs*` tokens in `journal.pcss` (replacing the deferral comment at :888), mapping each role to a dark-canvas-legible color from the dark token set (keywords/types → `#2dd4bf`; strings → link-external teal; comments → secondary; numbers/literals → critical; titles → primary weight-600). Target surface = dark code-card `#1a1c20`.
- **Acceptance:** AC#5 — syntax legible on the dark code card; no light-tuned token bleeds through (verified in the T-5.1 harness dark cell).

---

## Phase 2 — Message model (asymmetric bubbles)

### T-2.1: Flat non-self line + continuation overlap fix (shell.pcss)
- [ ] `.mx_EventTile[data-self="false"] .mx_EventTile_line`: `margin-left: 0; padding: var(--cpd-space-1x) var(--cpd-space-0-5x); border-color: transparent; background: transparent; box-shadow: none;`.
- [ ] Keep self bubble unchanged.
- [ ] Continuation overlap fix: `.mx_EventTile_continuation[data-self="false"] .mx_EventTile_line` re-adds a `padding-right` sufficient for the always-visible micro timestamp (so the absolute `.mx_EventTile_line > a` doesn't overlay trailing text), OR move the continuation timestamp into normal inline flow.
- **Acceptance:** flat assistant text has no bubble chrome; left edge aligns with the header (~+2px); continuation timestamp never overlaps message text (verified light+dark, both viewports, T-5.1).

### T-2.2: Avatar span at ALL non-self header render sites (components.tsx) + CSS
- [ ] **Glyph source (round-1 Maj1):** reuse the already-imported `matronLogo` (`components.tsx:19`, `res/matron-logo-simple.svg` — the matron brand robot mark, same asset the login screen uses). No new asset invented; operator may swap later (parallels the composer-radius nicety). Wrap in a shared tiny component `MsgAvatar` (`<img className="mj_MsgAvatar" src={matronLogo} alt="" aria-hidden />`) to avoid drift across sites.
- [ ] Add `<MsgAvatar />` as the leading child of `.mx_DisambiguatedProfile` at the **3** real `data-self="false"` render sites (round-1 Maj2 — there are 3, not 4; `state.toolStreams.map(...<ToolStream/>)` at ~2385 is a call site that instantiates the ToolStream fn, NOT a separate header): (i) `EventRow` (1997-2001), (ii) `ToolStream` fn (2026-2028), (iii) `textStreams` (2372-2374). Editing the `ToolStream` fn covers every tool-stream tile — do NOT add a node at the 2385 call site (would double the avatar).
- [ ] CSS: `.mx_DisambiguatedProfile` → flex row `align-items:center; gap`; `.mj_MsgAvatar` sized `--cpd-icon-md`, muted.
- **Acceptance:** AC#1 — every non-self tile (persisted `EventRow`, `ToolStream`, `textStreams`) shows the `matronLogo` avatar header exactly once; additive markup only, no logic change (AC#8).

### T-2.3: Timestamp placement conditional (components.tsx) + continuation always-visible
- [ ] `EventRow`: for `!own && !continuation`, render the `<a href="#event-N">…<time></a>` **inside** `.mx_DisambiguatedProfile` (after the name); do NOT also render it in `.mx_EventTile_line` — one location per tile (placement conditional on the existing `continuation` flag; no duplication).
- [ ] Continuation (`!own && continuation`): `<a>`+`<time>` stays in the line; CSS restyles it as an always-visible muted micro (tertiary, small) — not hover-only.
- [ ] Self: unchanged.
- **Acceptance:** AC#1/AC#8 — timestamp renders exactly once per tile (verified behaviorally, T-5.3); mobile-visible on continuations; no duplicate/missing.

### T-2.4: DisambiguatedProfile header restyle (shell.pcss)
- [ ] `.mx_DisambiguatedProfile` name → `--cpd-color-text-primary` weight-600 label (not dim secondary); header laid out `avatar · name · timestamp`.
- **Acceptance:** grouped run reads as one owner block with a clear header (T-5.1 continuation-run cell).

### T-2.5: Durable regression tests for the DOM contracts (round-1 M4 — P17 ratchet)
- [ ] In `test/unit-tests/journal/` (existing jest + jsdom infra — `components-test.ts` renders via `react-dom/client` `createRoot` + `act`, NOT `@testing-library/react`; match that pattern), add render tests for the **message-model** invariants a build/screenshot can't catch: (a) **exactly-once timestamp** — an `EventRow` first-in-group renders one `<time>` (in the header, not also in the line); a continuation renders one `<time>` (in the line); self renders one; (b) **avatar coverage** — `EventRow` (non-self, first-in-group), `ToolStream`, and `textStreams` each render exactly one `.mj_MsgAvatar`; self renders none. (The code-block-header test lives in T-3.1, which creates that node — round-2 B3; keeping it here would test a Phase-3 artifact from Phase 2.)
- If the fork lacks a component-render test harness, note it and fall back to asserting the render-branch structure via a lighter unit test; do not invent a new test stack (no new deps — spec constraint).
- **Acceptance:** tests fail on a duplicated/missing timestamp or a missing/doubled avatar; green on the correct implementation. These ratchet the P38 exactly-once contract beyond the one-time staging spot-check.

---

## Phase 3 — Cards & code

### T-3.1: Code-block `<span>` header wrapper + sticky CSS
- [ ] `markdown.tsx` (184-191): wrap the `<span mj_CodeBlock_lang>` + `<button mj_CodeBlock_copy>` in a `<span className="mj_CodeBlock_header">` (a `<span>`, phrasing-content-valid inside `<pre>`); `{children}` stays a direct `<pre>` child.
- [ ] `journal.pcss`: `.mj_CodeBlock_header { position: sticky; top: 0; left: 0; display: flex; justify-content: space-between; width: 100%; opacity: 1; }`; drop the hover-only fade + reserved top-padding; card bg → `--cpd-color-bg-canvas-default` + border + `--cpd-radius-lg`; header bg `--cpd-color-bg-canvas-raised`/hairline.
- [ ] **Render test (moved from T-2.5, round-2 B3):** in `test/unit-tests/journal/`, assert `CodeBlock` renders a single `.mj_CodeBlock_header` containing the lang node + copy button, and the copy handler is wired. (This node exists only after this task, so the test lives here.)
- **Acceptance:** AC#2 — white card, persistent header (lang left, copy right) pinned during vertical + horizontal scroll; copy works (behavioral, T-5.3 + this render test); no padding artifact.

### T-3.2: Diff line overflow-safe tint (journal.pcss)
- [ ] `.mj_DiffLine_add { background: var(--cpd-color-bg-diff-add); }` `.mj_DiffLine_del { background: var(--cpd-color-bg-diff-del); }` (keep text colors).
- [ ] `.mj_DiffLine_add, .mj_DiffLine_del, .mj_DiffLine_ctx, .mj_DiffLine_hunk { display: block; width: max-content; min-width: 100%; }` so the tint spans both the viewport and the full scrolled line.
- [ ] Diff card surface refit (radius/border consistent with code block).
- **Acceptance:** AC#3 — add/del tint spans full width in a `scrollLeft`-set cell (T-5.2); text colors preserved.

### T-3.3: Tool-card refit (journal.pcss)
- [ ] `.mj_ToolCard` + `summary` + `<pre>` bodies → v3 card treatment (surface/radius/border/elevation consistent with code + diff cards); failed state keeps `--cpd-color-text-critical-primary`.
- **Acceptance:** AC#4 — tool cards match the card system; failed state critical-colored.

---

## Phase 4 — Composer, header, sidebar

### T-4.1: Composer pill + teal send circle + mic style + static hint row
- [ ] `.mx_BasicMessageComposer_input` → pill using **`--cpd-radius-pill`** (round-1 M3 — pinned; "pill" is the v3 language and full-radius matches the mock). **No post-staging nudge** (round-2 B1 — a later radius change after the SHA is built/gated would ship an un-gated tree; the value is decided here, and any change re-enters the pipeline at T-5.1 with a fresh SHA + re-run gates); accent focus ring.
- [ ] `.mx_MessageComposer_sendMessage` → filled teal circle (`--cpd-color-bg-accent-emphasis` bg, `--cpd-color-text-on-accent` glyph).
- [ ] Style the existing disabled mic placeholder (muted/disabled affordance) — do NOT remove it (#470 owns voice).
- [ ] Add a `.mj_ComposerHint` row (additive TSX span) below the input: **static** left text `/ commands · shift+enter for newline`. Do NOT add the dynamic ctx%/auto-idle readout (deferred #501/#500).
- **Acceptance:** AC#6 — pill + teal send circle + styled mic placeholder + static hint row; no dynamic readout; additive markup only (AC#8).

### T-4.2: Header static refit (journal.pcss)
- [ ] Reconcile `.mj_ChatHeader` clusters (surface/border/shadow/type/spacing) to v3. Keep the single-context usage display + grid. Do NOT add usage metrics (#501) or ResizeObserver collapse (#500) or subagent strip (#502).
- **Acceptance:** header matches v3 static styling; AC#9 — no deferred-feature DOM/CSS added.

### T-4.3: Sidebar rows reconcile (shell.pcss)
- [ ] Reconcile residual literals in `.mj_RoomListItem*` against v3; confirm row rhythm (name · preview · timestamp · unread badge/dot); leave `.mj_RoomListTab*` untouched (#498 owns behavior).
- **Acceptance:** sidebar rows match v3; selected teal left-border + tint intact; tabs untouched.

---

## Phase 5 — Verification & atomic deploy

**Ordering invariant (round-1 Codex B2/B3 — P19a: every abort-capable gate precedes the irreversible live swap; SHA exists before evidence).** Sequence: **commit (SHA) → isolated staging build → asset + behavioral + visual + operator sign-off ALL on staging → evidence/manifest (SHA available) → /ship-slim + PR + merge → live swap (the single irreversible step, all gates already green) → post-swap smoke.** The live swap is last; nothing abort-capable happens after it.

### T-5.1: Commit implementation + isolated staging build
- [ ] **Commit the implementation FIRST** (Phases 1-4); `SHA=$(git rev-parse HEAD)`. This makes the SHA available to every downstream gate + the manifest (round-1 B3).
- [ ] `git worktree add --detach /tmp/mw-build-$TS "$SHA"`; `corepack pnpm install --frozen-lockfile && corepack pnpm build` → `/tmp/mw-build-$TS/webapp` (live `/opt/matron/web-journal/webapp` untouched).
- **Acceptance:** implementation committed; `SHA` recorded; staging build produced out-of-path; live untouched.

### T-5.2: Static verification harness (OUTSIDE the deploy root) + screenshot matrix + evidence
- [ ] Build the static harness HTML in a **scratch dir OUTSIDE `webapp/`** (e.g. `/tmp/reskin-harness/`, round-1 M2 — `webapp/` is the rimraf'd build output; a harness there is erased by the build or shipped publicly). Render every in-scope surface (assistant-flat, user-bubble, continuation-run, live-ToolStream tile, live-textStream tile, code-block, diff-card add/del incl. a long line, tool-card, composer, header, sidebar-rows) under both `:root` and `[data-theme="dark"]`, importing the built CSS from the staging tree. Inline `<script>` sets `scrollLeft` on overflow cells (diff long line, code-header pin) before capture.
- [ ] Capture the anchor at **both** viewports (1440×900 + 390×844) → `docs/superpowers/evidence/2026-07-24-reskin/anchor-<viewport>.png`.
- [ ] Capture the full matrix (surfaces × {light,dark} × {1440×900, 390×844}) → `evidence/<surface>-<theme>-<viewport>.png`; Read + compare each against the anchor (structural/color/spacing parity).
- [ ] Write `evidence/manifest.json` tying each cell → the committed `SHA` + pass/fail. Leave it **uncommitted** here — T-5.3 appends the test-pass + sign-off records and commits the whole evidence dir once, after sign-off (round-2 M4). It cannot live in the deployed `SHA` (committing it changes the SHA), so it's a separate commit.
- **Acceptance:** AC#10 — harness is outside the deploy root; every matrix cell captured/compared/manifested to `SHA`; mobile column present.

### T-5.3: Test suite + staging gates + operator sign-off + evidence commit (ALL pre-swap)
- [ ] **Test gate (round-2 M3 — P17 ratchet actually runs):** run the repo's unit-test command (confirm exact script in `package.json` at execute time, e.g. `corepack pnpm test`) — the new T-2.5/T-3.1 render tests + the existing suite must pass. `pnpm build` does NOT run jest, so this is a distinct gate. Record pass + commit SHA in the manifest.
- [ ] **Staging runtime contract (round-1 M1):** serve `/tmp/mw-build-$TS/webapp` on a scratch port with a proxy that mirrors the nginx vhost — `/journal/` → `127.0.0.1:9810` (the journal server) with WS upgrade — so the same-origin client (`config.json journal_server_url=/journal`) reaches the real API; authenticate by logging in with the `fantin` journal creds. (Alternatively point a scratch `config.json` at the absolute journal URL `https://vmi3096107.taild3d6c4.ts.net:9810`, Electron-style, avoiding the proxy.) Assert server readiness before gating.
- [ ] Asset gate: every hashed JS/CSS bundle referenced by `index.html` returns 200 (not root-only).
- [ ] Behavioral gate (logged in, on staging): copy-button copies; relocated timestamp renders exactly once (cross-checks T-2.5); the avatar header renders. **The staging client proxies to the REAL journal backend (round-3 M1 — P19a), so isolate the test:** use a dedicated throwaway test conversation and a predetermined **read-only** prompt (e.g. `!echo` / a trivial no-side-effect message that elicits a short streamed reply + at most a read-only tool like a file `Read`); explicitly NO mutating/egress tool calls — the pre-sign-off gate must not change production state. The streaming/ToolStream render can be verified with that bounded interaction (or against captured fixtures if a live tool call can't be made read-only).
- [ ] Real-DOM visual spot-check of the streaming/assistant tiles at **both** viewports on staging.
- [ ] **Operator sign-off on STAGING** (round-1 B2 — before the live swap): both themes AND both viewports on the real staging app. Record in the manifest.
- [ ] **Commit evidence AFTER sign-off (round-2 M4):** now that the manifest holds test-pass + all gate results + the sign-off record, commit `docs/superpowers/evidence/2026-07-24-reskin/` in one commit. This is the "separate follow-up commit" (the evidence can't live in the deployed `SHA`); it lands before `/ship-slim` so the sign-off isn't stranded uncommitted and `/ship-slim` sees a clean tree.
- **Acceptance:** AC#10 — test suite + asset + behavioral + real-DOM visual + operator sign-off ALL pass on staging and are committed BEFORE any live mutation.

### T-5.4: Ship the SHA (PR + merge) + pre-swap bookkeeping — still before the live swap
- [ ] `/ship-slim` (Codex adversarial on the diff) → PR to easelyte/matron-web → merge. **Provenance (round-3 B2 — a commit-message citation is NOT tree-equivalence):** verify `git merge-base --is-ancestor "$SHA" origin/main`. If the merge squashed (SHA is not an ancestor) OR conflict-resolution/review-fixes changed any deploy-affecting file, the built artifact is no longer proven == main → **re-enter at T-5.1 with the merged commit as the new SHA and re-run gates**. Do NOT accept "the squash commit cites $SHA" as provenance.
- [ ] **File the two follow-up loops NOW (round-3 M2 — before the irreversible swap, not after):** deploy-hardening (zero-gap symlink-flip release + service-start recovery preflight + the round-1 B1 crash-window residual) and P18 `.pcss`-split. Filing these is abort-capable bookkeeping and must not trail the swap.
- **Acceptance:** the reviewed SHA's content is provably merged to main (ancestry, not citation) BEFORE it goes live; follow-up loops filed; provenance recorded. (If PR review rejects, no live mutation has happened — nothing to roll back.)

### T-5.5: Live swap — the single irreversible step (R102-gated), then post-swap health-or-restore
Author the deploy script to satisfy these invariants (exact commands authored + dry-run at execute time — stated as invariants, not nitpickable one-liners, so failure branches are proven rather than assumed):
- [ ] **Source integrity (round-2 B1):** the tree being swapped live is the exact built `SHA` from T-5.1, and that content is what merged to main in T-5.4. If ANY source changed after T-5.1 (a fix, a nudge), do NOT swap — re-enter at T-5.1 with a fresh SHA and re-run all gates. Assert the staging tree's provenance before swapping.
- [ ] **Rename topology (round-2 M2 — the nesting trap):** never `mv <staging> webapp` while `webapp/` exists (that moves staging *inside* live). Required order with target-nonexistence assertions: `cp -a webapp webapp.bak.$TS` (guard the copy); assert `webapp.prev.$TS` doesn't exist → `mv webapp webapp.prev.$TS` (guarded); assert `webapp` now absent → `mv <staging> webapp` (guarded). Each `mv` on its own line with `|| { restore; exit 1; }`, NEVER chained with `&&` (the `&&` exempts the first from `set -e`/trap).
- [ ] **Guards:** crash-recovery preflight (if `webapp/` absent at start, restore newest bak **directory** by mtime — `ls -1dt webapp.bak.*/ | head -1`, the `-d` is load-bearing, else `ls` lists dir *contents* not the dirs, round-3 B1; NOT lexicographic sort — the live dir has a `webapp.bak.deploy-*` that sorts last but is older; prune pre-existing baks first); `flock` deploy lock; same-FS assert (`stat -f` staging vs live parent); R102 confirmation token gates the whole swap.
- [ ] **Restore is symmetric to the forward swap (round-3 B1 / final-review round-2 B1 — a restore must NOT `mv bak webapp` while `webapp/` exists, same nesting trap; but must ALSO handle `webapp/` already absent after a mid-swap failure):** every restore path = **IF `webapp/` exists**, quarantine it (assert `webapp.failed.$TS` absent → `mv webapp webapp.failed.$TS`, guarded); **ELSE** (mid-swap failure already renamed it away) skip quarantine — do NOT `mv` a nonexistent `webapp`, which would abort restore and leave the client down. Then: assert `webapp` absent → `mv <bak> webapp` (guarded) → health-check the restored release. Recovery precedes any pruning. The mid-swap failure-injection dry-run MUST exercise this exact absent-`webapp` restore path.
- [ ] **Dry-run the FAILURE branches** (round-1 Codex B1 / round-2 B2 / round-3 B1), not just the non-destructive prefix: in a scratch dir, inject and prove (a) mid-swap rename failure → restore fires + restored release healthy, (b) unhealthy post-swap release → quarantine+restore fires, (c) absent-live preflight → correct bak selected (`ls -1dt`) + restored. All three restore paths proven before touching live.
- [ ] **Post-swap health-or-restore (round-2 B2/M1 — P51 rollback surface = protection surface):** after the swap, run the SAME asset-level check as staging against LIVE — parse live `index.html`, assert every referenced hashed JS/CSS bundle returns 200 (NOT just root-200, which passes on a partial deploy). If it fails, run the symmetric restore above. The swap is "committed" only once live health passes.
- [ ] **Durable post-deploy record (round-3 M3 / final-review M1 — P34 observability):** append a structured event to `docs/superpowers/evidence/2026-07-24-reskin/deploy-log.jsonl` — `{sha, ts, backup_path, release_path, live_asset_check: pass|fail, restore_fired: bool, restored_health, final_status: deployed|rolled-back}` — so "deployed" vs "rolled back" is distinguishable after the shell exits / on later audit. **This append happens AFTER the swap + after T-5.4's merge, so it must land on `main`, NOT the already-merged feature branch** (final-review round-2 B2 — an unqualified `git push` on the deleted/merged branch never reaches canonical history). Commit it on `main` and push there: `git -C <repo> checkout main && git pull --ff-only && git add docs/superpowers/evidence/2026-07-24-reskin/deploy-log.jsonl && git commit -m "chore: reskin deploy-log <status>" && git push origin main` (or a tiny follow-up PR if `main` is protected). Verify the record is reachable from `origin/main` before closing. Retryable — the record is on-disk regardless; a failed push leaves a pending-state note. Then close #497 (retryable bookkeeping — the durable record + filed follow-up loops mean a failed close is resumable, not a lost state).
- **Acceptance:** AC#10 — swap is last, guarded/same-FS/lock-serialized/token-gated, all three restore branches dry-run-proven; post-swap LIVE asset-level health passes (or symmetric restore fired); a durable deploy-log record distinguishes deployed vs rolled-back; #497 closed.

*(Residual, follow-up-owned: the sub-second SIGKILL/power-loss window between renames (round-1 Codex B1) — a manually-run operator-gated one-off deploy accepts it; the zero-gap symlink-flip scheme in the deploy-hardening loop eliminates it.)*

---

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.
