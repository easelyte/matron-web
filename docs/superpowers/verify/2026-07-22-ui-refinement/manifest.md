# Verification manifest — matron-web UI refinement (#487/#488/#489)

Branch `feat/ui-refinement`. Plan: `docs/superpowers/plans/2026-07-22-web-ui-refinement.md`.

## Automated gates (verified in-session, scratch build)

| Gate | Result |
|---|---|
| `pnpm lint:types` (`tsc --noEmit`) | ✅ PASS (0 errors) |
| `pnpm test` (jest, full suite) | ✅ PASS — 562 tests / 32 suites (baseline was 544/31; +18 new theme tests: `theme-test.ts` — enum-validate, storage-throw + `setTheme`-applies-DOM, mq-after-failed-write, `nextThemePref` cycle, inline-script parity execution, `ThemeToggle` 3-click) |
| `pnpm build` (webpack production) | ✅ PASS — compiled; both `shell.pcss` (22.7 KiB) + `journal.pcss` (44.7 KiB) built. 3 pre-existing bundle-size warnings (main 726 KiB) — unrelated, tracked separately (bundle-trim loop). |

## Per-phase Codex adversarial review (execute-slim boundaries)

| Phase | Verdict | Fixes applied |
|---|---|---|
| Phase 1 (banner) | 2 blockers → fixed (9e8df5e) | room-width header reflow (701px clip); accessible usage progressbars (a11y parity) |
| Phase 2 (dark theme) | 1 blocker + 2 majors → fixed (eaa3cb3) | in-memory pref survives denied-storage across OS-theme change; module-init `applyTheme` (CSP fallback); cross-tab `storage` listener |
| Phase 3 (type-scale) | 1 blocker → fixed (0f91458) | compact 18px line-height on header title (28px overflowed the 38px multi-row cluster) |
| Phase 4 (spacing) | LGTM | — |

## Pending — BROWSER-gated (not live-deploy-gated; final-review Major 1 correction)

The plan (T-5.2) permits serving the worktree production build on a throwaway port — so the visual matrix does NOT strictly need the live deploy. The actual blocker is **browser automation** (headless Chromium + screenshot + pixelmatch), which is unavailable to both the Codex implementer sandbox (why T-1.4/T-3.2 returned DONE-WITH-UNCERTAINTY) AND this Matron bridge session (browser tools off — would need `/restart --browser`). So the visual matrix is deferred to a session/operator WITH a browser. The operator's own ship instruction ("verify BOTH light and dark render on live `:8443`") covers this. Pending checks:

- [ ] **Viewport × state matrix** ~360 / 700 / 1200px × {chat, subchat, auth, drag-active, empty, running-session, tool-output-visible, scrolled-up} — verify no hard clip; title dead-center; usage rows stack at 360px; reset-time via `title` hover.
- [ ] **Light-mode pixel-identity** — before(`origin/main`)/after(branch), excluding the live-counter region + the Phase-1 header/timeline displacement; small pixelmatch tolerance; deliberate snaps enumerated (`14.0625→15`, `11→10`, `9→10`, `15→18`, `13→14`).
- [ ] **Dark-mode coverage** — OS-dark / toggle=Dark: NO white surface remains (incl. status pill, auth modal, drag overlay, room "paper" canvas, left panel, composer, bubbles, homepage).
- [ ] **Contrast** — spot-check the enumerated AA pairs on the built output.
- [ ] **Live `:8443`** — rebuild the live deploy dir per `reference_matron_web_deploy` atomic runbook, verify BOTH light and dark render (operator's explicit instruction). This is the R102-gated live-deploy step, run by the operator.

Screenshots to be attached here (or to the PR) when the operator completes the live check.
