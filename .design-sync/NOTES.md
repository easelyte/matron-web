# design-sync notes: matron-web

Repo-specific gotchas for syncing matron-web to claude.ai/design (project
`9c8de8df-b75b-4e3b-8540-68dce40b1d88`, package shape, `window.MatronWeb`).

## How the build works

- matron-web is an app (webpack, no library build). `cfg.buildCmd`
  (`node .design-sync/build-pkg.mjs`) synthesizes a package into the gitignored
  `.ds-sync/pkg/`. See the header of `build-pkg.mjs` for the layout. In short: a copy of
  `src/journal/` with three modules swapped for `.design-sync/shims/`, `.design-sync/src/`
  copied to `src/ds/`, a barrel (`index.mjs`) over exactly the `SURFACE` table, `icons.mjs`
  (extra entry), `cards/<group>/<Name>.tsx` discovery stubs, a tsc `.d.ts` tree, and
  `styles.css` (the four `.pcss` through postcss-preset-env, like webpack).
- The **SURFACE table in build-pkg.mjs is the card list** and carries each component's group
  and summary doc. Add a component there, not in `componentSrcMap`.
- Config paths (`srcDir`, `cssEntry`, `extraFonts`, `extraEntries`) are relative to
  `.ds-sync/pkg/` (PKG_DIR, because of `--entry ./.ds-sync/pkg/index.mjs`).
- Full rebuild: `bash .design-sync/rebuild.sh` (build-pkg + package-build).
- Driver run: `node .design-sync/build-pkg.mjs` then
  `node .ds-sync/resync.mjs --config .design-sync/config.json --node-modules ./node_modules --entry ./.ds-sync/pkg/index.mjs --out ./ds-bundle`.
- Memory: run every build / validate / capture / driver command under
  `systemd-run --scope --quiet -p MemoryMax=3G -p MemorySwapMax=1G <cmd>`, one at a time.
  Observed peaks: full rebuild ~0.47 GB RSS, validate ~0.25 GB, capture ~0.17 GB.
  The app has no icon library (icons are hand-drawn SVG components in `src/journal/icons.tsx`),
  so the whole-icon-library OOM mode (a preview importing lucide-react) does not apply here.
- Playwright: the repo pins `@playwright/test@1.62.1` = chromium-1234 (cached in
  `~/.cache/ms-playwright`). The converter imports `playwright` from `.ds-sync/node_modules`, so
  install `playwright@1.62.1` there alongside esbuild / ts-morph / @types/react.
- tsc for the `.d.ts` tree pins React types to the repo's `node_modules/@types/react` via
  `paths`: `.ds-sync/node_modules` has its own `@types/react`, which is nearer to the copy and
  otherwise yields "two different types with this name exist" errors. `.ds-sync/pkg/tsc.log`
  should be empty after a build.

## Shims (bundle + previews only; the app is untouched)

- `shims/connection.ts` replaces `src/journal/connection.ts`: inert `JournalConnection`
  (no WebSocket; agent RPCs resolve to a relay failure). Mirrors the public methods client.ts
  calls (start, stop, send, forceResync, reconnectNow, agentRequest).
- `shims/database.ts` replaces `database.ts`: `JournalDatabase.open()` rejects, instance
  methods are typed no-ops (mirror of the real public surface, so client.ts type-checks).
- `shims/pdf-render.ts` replaces `pdf-render.ts`: no pdf.js (several MB + a worker the canvas
  can't fetch). Paints a page-shaped canvas (title bar + grey lines, 3 pages). PDF previews
  therefore show a stand-in document, not the real PDF.
- `api.ts` (fetch) and `files/filesApi.ts` stay real: they only run with a session, and fixture
  clients have none (their Files API is the canned `createFixtureFilesApi()`).

## Fixtures and theme

- `.design-sync/src/fixtures.tsx` exports `createFixtureClient({ screen, state, filesWritable })`:
  a real `MatronJournalClient` whose private store is pre-patched to a signed-in account on one
  surface, with `listAgents`, `recentFolders`, `mediaUrl` and `filesApi` stubbed. It ports the
  data of `fixtures/index.tsx` (the repo's Playwright fixture entry, a side-effecting script that
  can't be imported). Timestamps are relative to `Date.now()` (the repo fixture uses
  `T = 1_782_000_000`, which is ms-since-epoch for Jan 1970, so its dates read as 1970).
- Source files under `.design-sync/src/` import `../journal/...`: that resolves only in the
  `.ds-sync/pkg/src/ds/` copy, not in place (editors show the imports as broken; expected).
- Themes are token blocks on `[data-theme="dark"]` (any element), so `MatronThemeProvider`
  (cfg.provider) and a nested `<MatronThemeProvider theme="dark">` can mix themes on one page.
  **Alias tokens** (`--mj-summary-raise`, `--cpd-focus-ring`) are declared on `:root` as
  `var(--other)`, which resolves once at `:root`; build-pkg appends a `[data-theme] { ... }`
  rule re-declaring them so a dark subtree re-resolves. Without it the pinned summary renders
  as a white panel in dark subtrees (never visible in the app, where data-theme is on `<html>`).
- `journal.pcss` pins `html, body, #matron` to the viewport with `overflow: hidden`. build-pkg
  scopes that rule to `#matron` only (it would clip every card and every scrolling design);
  build-pkg throws if the rule text changes.
- The phone layout is `@media (max-width: 700px)` (plus 760px in places): it only appears when
  the page viewport is narrow, so phone cards (`MatronMobileScreen`, `MobileNav`) carry a
  438px-wide viewport override (390px content after the 24px card padding). Width-constrained
  wrappers inside a wide page do NOT trigger the phone layout.
- Fonts: Inter 400/600 and Fira Code 400 from `@fontsource` (same subsets the app imports in
  `src/journal/index.tsx`), via `cfg.extraFonts`. The CSS asks for weight 500 in places
  (`--cpd-font-label`, `--cpd-font-body-strong`); the app ships no 500 face either, so it
  renders with the nearest face, same as production.

## Authoring previews

- Import everything from `"matron-web"`: components, `MatronThemeProvider`, the fixture helpers
  (`createFixtureClient`, `fixtureItems`, `fixtureEvents`, ...), icons and glyphs.
- Write stories as `export const Name = () => (...)` (arrow consts): only that form is copied
  into the `.prompt.md` Examples section.
- Components taking `client` (and `state`): `const client = createFixtureClient({ screen })` at
  module level, `state = client.getSnapshot()`.
- Dark cells: wrap in `<MatronThemeProvider theme="dark">`.
- Phone-width cells for non-media-query components: a fixed `width: 360` wrapper; the card then
  needs `cardMode: column` (a 360px story overflows a grid cell).

## SVG imports

- The converter's esbuild loads `.svg` as a raw-text `data:image/svg+xml,<svg ...>` URL. The app
  embeds the logo as `url("${matronLogo}")` in a CSS mask (MsgAvatar, the agent avatar in every
  timeline row), and the raw URL's double quotes end that CSS string early, so the avatar
  rendered as a grey square. build-pkg rewrites each `import x from "...svg"` in the copy to a
  generated sibling `<name>.svg.ts` exporting a base64 data URL. `bundle.mjs` can't be forked
  (output contract), hence the source rewrite.

## Component scope

47 cards. Chosen surface = the presentational pieces a designer composes Matron screens from,
plus whole-screen renders of the real app. Groups (from `build-pkg.mjs` SURFACE):
- **screens**: MatronScreen, MatronMobileScreen (real MatronApp + fixture client; the only way to
  see the non-exported internals: sidebar, conversation rows, composer, message tiles,
  LoginScreen, upload confirm).
- **conversation**: EventContent, MarkdownBody, DiffCard, ToolStream, QueuedReleaseCard,
  PinnedSummary, SubagentStrip, MessageSearchResults.
- **chrome**: HeaderShell, UsageCluster, ThemeToggle, NewSessionSheet, EditFileSheet.
- **tracker**: TrackerPane, ItemsInbox, ItemRow, ItemDetail, MissionsList, MissionDetail,
  WorkView, ItemCard, ItemInlineNote, MilestoneCard, MissionNotice, TrackerGlyph, NeedsYouBadge.
- **mobile**: MobileNav, NavBadge, ConnectionStatus.
- **files**: FilesPane, FilePreview, CodePreview, MarkdownPreview, ImagePreview, PdfPreview,
  MediaPreview, GenericPreview, TooLargePreview, PreviewStatus, MediaError, DownloadControl,
  FileWriteDialog.
- **media**: MediaViewer.
- **foundations**: IconCatalog, DesignTokens (design-sync reference cards rendering the real
  icon modules and the shell.pcss tokens; `.design-sync/src/catalog.tsx`).

Exclusions (exported unless noted, no card):
- `MatronApp`: needs a live `MatronJournalClient`; shown through MatronScreen / MatronMobileScreen
  with a fixture client instead (cardless export, `componentSrcMap: null`).
- `ConnectionBanner`: renders nothing until the connection has been down for 2.5 s
  (`CONNECTION_BANNER_DELAY_MS`); captures happen at networkidle, so it can't be shown
  statically. Cardless export. (ConnectionStatus covers the offline visuals.)
- `MatronThemeProvider`: the cfg.provider wrapper, cardless export.
- The 50 icons in `icons.tsx` and the 8 discrete tracker glyphs: exported via `icons.mjs`
  (extraEntries), no card each; all shown in IconCatalog. TrackerGlyph covers the kinds.
- Not exported at all: the non-exported internals of `components.tsx` (Sidebar, conversation
  list rows, Composer, EventRow/message tiles, PromptCard, AgentSpawnCard, PeerMessage,
  LoginScreen, HomePage, settings menu); they have no public API to render in isolation and are
  covered by the screen cards. `index.tsx` (app entry), `ansi.tsx` (functions only), and the
  non-component modules (client, api, database, connection, stores, formatters).

Composition notes from the preview waves:
- EventContent previews wrap in `.markdown-body` (its real ancestor in EventRow); ToolStream
  renders an `<li>`, so its previews wrap it in `<ol className="mx_RoomView_MessageList">`.
- Overlays (NewSessionSheet, EditFileSheet, FileWriteDialog, MediaViewer) use a
  `position: fixed` scrim. `.ds-single` (translateZ) is its containing block but only as tall as
  the story, so each story sits in a fixed-height stage (viewport minus gutters).
- Sheets are driven by `client.listAgents` only: variants via
  `Object.assign(createFixtureClient(), { listAgents })` (pending promise = loading, rejection =
  error, [] = no boxes).
- ConnectionStatus styles are scoped to `.mj_HeaderMenu`; its preview wraps it in that class.
- File preview cells wrap in `mj_FilesPane_preview`; that class is `flex: 1 1 0`, so stacking
  two in a flex column collapses both. Stack with grid.
- Loading states: an api method returning `new Promise(() => {})`; errors: reject with an Error
  carrying the app copy.
- The Work view's repo fixture (`work-view-ok.json`) has placeholder titles; WorkView and
  TrackerPane previews use inline realistic loaders. `createFixtureClient` stubs `client.work`
  with `fixtureWorkViewLoader`.
- The 360px cells for media-query-driven components (tracker panes, FilesPane) show the desktop
  layout squeezed, not the phone layout; the phone layout lives in MatronMobileScreen and
  MobileNav (438px viewport cards).
- Interaction-only states skipped (no prop reaches them): ToolOutput/diff expand, PinnedSummary
  collapse and per-bullet expand, header hover popovers, ThemeToggle light/dark (localStorage),
  sheet starting/saving/saved states, MediaViewer zoom/pan/later pages, inbox "All open" filter,
  closed-missions expander, item kebab menu, close-mission confirm, WorkView All/Domain,
  DownloadControl busy/error, FileWriteDialog edit mode, FilesPane write notices and Show
  hidden, Copy -> Copied, MobileNav keyboard-up hide.

## Known render warns

- `tokens: 1 missing, below threshold`: expected (a runtime-set custom property).
- `[RENDER_BLANK]` never fired on authored cards; if a tiny component (NavBadge, NeedsYouBadge,
  ThemeToggle) trips it, compose it in context rather than accepting a blank card.

## Re-sync risks

- **Shims mirror real module surfaces**: `shims/connection.ts` and `shims/database.ts` copy the
  public methods client.ts calls. A new method on the real modules makes `.ds-sync/pkg/tsc.log`
  non-empty (and the bundle may throw at the new call). Check tsc.log after every build-pkg.
- **build-pkg text couplings** (it throws when they break): the `html, body, #matron` pin rule in
  journal.pcss, the `:root` block in shell.pcss, and the three shimmed filenames. The SVG import
  rewrite matches `import x from "....svg";` only.
- **SURFACE table** hard-codes module paths per component; a moved/renamed component fails the
  build (barrel import) rather than silently dropping.
- **Fixture data** (`.design-sync/src/fixtures.tsx`) is typed against `src/journal/types.ts` via
  the tsc run, but mirrors `fixtures/index.tsx` by hand: new app surfaces or state fields won't
  appear in MatronScreen until added there. The Work loader reads the repo's
  `__tests__/fixtures/work-view-ok.json`.
- **Theme scoping**: the `[data-theme]` alias re-declaration is derived from `var()` values in
  the `:root` block; a new alias token defined outside `:root` would need adding.
- **PDF rendering is a stand-in** (shim) in every card and design; real PDF fidelity is not
  verified here.
- **Capture height**: captures are viewport-only (700 px default); long panes are shown in
  fixed-height frames, so content below the fold (e.g. MissionDetail's close form in the long
  cells) is only covered by separate cells.
- **Not verified**: rendering inside the real claude.ai/design canvas (headless chromium only);
  grades are this sync's (no upload anchor yet). Toolchain assumed: Node 22, pnpm 10,
  playwright 1.62.1 / chromium-1234, esbuild + ts-morph staged in `.ds-sync/`.

## App-level UI defects noticed during the sync (not sync bugs; for the redesign)

- Header: the title truncates hard when the meters are shown (desktop subtitle
  "claude-opu... · resets... · runn..."; phone title "matron..." / ~10 chars at 360px).
- Phone conversation: the pinned summary takes about half the viewport and hides later bullets
  behind an inner scroll with no affordance; the milestone card under it is partly covered;
  `ctx 72%` appears in both the header and the composer footer.
- Phone Files: the list and a "Select a file to preview it" placeholder split the screen.
- QueuedReleaseCard expired row: "Expired - no longer actionable" lands in the 24px icon column
  and wraps one word per line; several queued messages stack with no separation.
- Prompt/permission question text isn't markdown-rendered (literal backticks); an answered
  question shows "Answered" instead of the chosen option.
- Long diff lines clip with no scroll hint.
- EditFileSheet textareas are unstyled native controls (light grey slab in dark mode);
  "Load current contents" / "Back" read as plain text links.
- MediaViewer: caption lands in the monospace filename slot when there's no filename; the PDF
  zoom bar overlaps the page bottom.
- NeedsYouBadge's "?" glyph renders ~6 px and reads as a dot; the badge ignores font-size.
  NavBadge's fixed anchor lets "20+" / "99+" cover most of the phone tab icon.
- Tracker: closed items still show the Reply composer; narrow widths squeeze titles next to
  status pills and the pane header tabs.
- Files: a 403 folder leaves a breadcrumb with only the failed segment; CodePreview labels an
  nginx `.conf` as "bash"; the audio preview is a bare native player; MediaError is grey
  tertiary text while PreviewStatus errors are red (two treatments for one failure); Rename
  stays disabled until the name changes with no hint; delete dialogs focus the close X first.
- The repo's own `fixtures/index.tsx` uses `T = 1_782_000_000` as epoch-ms, so its timeline
  dates read as January 1970.
