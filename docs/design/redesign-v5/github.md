repo: easelyte/matron-web
branch: main
path: src/journal

## Round 2 (2026-07-26T09:22Z)
Designed four more surfaces (prompt/question card, new-session sheet, conversation-actions menu, upload modal) into redesign-v5. Added GENERATIVE-SYSTEM.md §10 cross-cutting invariants; themed native chrome (scrollbars, global focus-visible, selection) with three new tokens; 28 static states incl. 8 round-2; component-map now 83 entries (18 aligned / 21 divergent / 36 unverified). Sidebar ⋯ dropped — right-click only.

## Last sync
date: 2026-07-25T19:50:00Z
tree: 0bea310ef3e8

### Updated in this project
- Aligned every data-spec tag to the granularity of its component-map selector; split multi-rung components (composer footer/shell/input, modal scrim/card, row/badge).
- Split map status into `status` (code exists) and `visual` (matches design): 17 aligned, 10 divergent, 36 unverified.
- Self-hosted Inter + Fira Code in static/fonts/ (OFL, from rsms/inter and google/fonts) so the static states are screenshot-faithful offline.
- Added GENERATIVE-SYSTEM.md (order of sacrifice, content ranges, a11y intent, choreography, parameter space, derivation rules, anti-goals) and tools/probe.js; recorded all five design uncertainties as resolved.

### Previous sync (2026-07-25T18:38Z, tree eb6e7d6f3c4b)
- Re-read journal.pcss / shell.pcss / components.tsx / status.ts at HEAD; confirmed much of redesign-v4 has already landed.
- Added a state matrix covering every EventContent type (text, prompt, permission_request, prompt_reply, tool_output, diff, image, file, unknown) plus error/empty/disabled/focus-visible states.
- Emitted 20 runtime-free static states (static/) + index.json for headless probing.
- Wrote component-map.json (data-spec → mj_/mx_ selector, implemented/new/devtool) and CHANGELOG-vs-current.md.

## Screen map
| Screen / artifact | Built from |
|---|---|
| Sidebar, tabs, empty states | src/journal/components.tsx (RoomList, mj_RoomListEmpty copy), journal.pcss .mj_RoomList* |
| Header, usage cluster, popovers | components.tsx (buildUsageMeters, UsageCluster), status.ts (usageLevel, resetDisplay, usageBarLabel), journal.pcss .mj_ChatHeader/.mj_Usage* |
| Thread content types | components.tsx EventContent switch, PromptCard, ToolOutput, AuthenticatedMedia, DiffCard |
| Composer, slash palette, voice | components.tsx composer + voice recording, slash-palette.ts, journal.pcss .mx_MessageComposer/.mx_SlashPalette/.mj_VoiceRecording |
| Upload modal + queue | components.tsx upload dialog, journal.pcss .mj_UploadConfirm* |
| Attachment chips | components.tsx attachment chip, journal.pcss .mj_AttachmentChip* |
| Matron Current.dc.html | earlier snapshot of shell.pcss + journal.pcss (superseded by CHANGELOG-vs-current.md) |
