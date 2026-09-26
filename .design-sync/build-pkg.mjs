#!/usr/bin/env node
// design-sync buildCmd for matron-web (cfg.buildCmd). matron-web is an app (webpack, no library
// build), so this synthesizes a package into the gitignored .ds-sync/pkg/ that the design-sync
// converter reads as `--entry ./.ds-sync/pkg/index.mjs`:
//
//   src/journal/   copy of src/journal/ (tests dropped) with three modules swapped for the
//                  inert stand-ins in .design-sync/shims/: connection.ts (WebSocket),
//                  database.ts (IndexedDB), pdf-render.ts (pdf.js). The app itself is untouched.
//   src/contracts/, res/   copied so the journal copy's relative imports resolve.
//   src/ds/        .design-sync/src/ (fixture client, MatronScreen, theme provider, catalogs)
//                  + tokens.json parsed from shell.pcss.
//   index.mjs      barrel: named re-exports of exactly the SURFACE below (the card list).
//   icons.mjs      the icon set + discrete tracker glyphs (cfg.extraEntries: on the global,
//                  no card each; IconCatalog shows them all).
//   cards/<group>/<Name>.tsx  discovery stubs carrying each component's group + JSDoc
//                  (cfg.srcDir = "cards"): the converter reads group from the directory and
//                  the doc from the leading /** */ block. Never compiled.
//   types/         real .d.ts tree emitted by tsc from the copy.
//   styles.css     shell + journal + tracker + mobile .pcss through postcss-preset-env, exactly
//                  like webpack.config.mjs, in the index.tsx import order.
//
// Run from the repo root: node .design-sync/build-pkg.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve('.');
const OUT = join(ROOT, '.ds-sync/pkg');
const DS = join(ROOT, '.design-sync');
const J = 'src/journal';

// The design-system surface: every component that gets a card, its group, and the one-paragraph
// doc the design agent reads first (.prompt.md summary). Exclusions and their reasons live in
// NOTES.md; CARDLESS below are exported (with .d.ts) but get no card.
const SURFACE = [
  // screens
  ['MatronScreen', 'ds/screens.tsx', 'screens', 'A whole Matron screen at desktop width: the real app (sidebar, header, timeline, composer, tracker, files) rendered from a fixture client. `screen` picks the surface (chat, subagent, list, files, files-preview, tracker-missions, tracker-mission, tracker-inbox, tracker-item, tracker-work, search, upload, offline, signed-out). The layout reference for any redesign.'],
  ['MatronMobileScreen', 'ds/screens.tsx', 'screens', 'The real app at phone size (390 x 844). The phone layout comes from `@media (max-width: 700px)`: sidebar XOR main region, bottom tab bar, compact header. Only renders as a phone inside a phone-width viewport.'],
  // conversation
  ['EventContent', 'journal/components.tsx', 'conversation', 'Renders the body of one journal event in the timeline, dispatching on `event.type`: markdown text, tool output, diff, permission and question prompts, agent-spawn consent, peer messages, tracker markers, images, files; unknown types fall back to a diagnostic card. Needs a `client` (use `createFixtureClient()`) and `answeredPromptReplies` (a Map, usually empty).'],
  ['MarkdownBody', 'journal/markdown.tsx', 'conversation', 'The markdown renderer for agent and user messages: GFM (tables, task lists, strikethrough), highlight.js code fences with a copy button, and `#item` / `mission` tracker links. Wrap in `.mj_Markdown` for message typography.'],
  ['DiffCard', 'journal/components.tsx', 'conversation', 'A file-edit card: tool + path header, +/- counts, and a unified diff with added/removed line tints; long diffs fold at 12 lines behind an Expand control. Build `data` with `parseDiffPayload(event.payload)`.'],
  ['ToolStream', 'journal/components.tsx', 'conversation', 'Live output of a running tool call (terminal-style, ANSI colours rendered), shown while a command streams before its final tool_output card lands.'],
  ['QueuedReleaseCard', 'journal/components.tsx', 'conversation', 'The "queued messages" prompt: the agent is busy, the operator\'s queued messages wait, and the card offers Send now / Cancel (or shows the resolved outcome).'],
  ['PinnedSummary', 'journal/components.tsx', 'conversation', 'The pinned rolling digest at the top of a conversation: bullet list the bridge maintains, "updated Nm ago", per-bullet clamp with Expand, and a collapse toggle. Renders nothing when `summary` is null.'],
  ['SubagentStrip', 'journal/components.tsx', 'conversation', 'The SUBAGENTS strip under the conversation header: one pill per child session with state (running spinner, done, failed), click to open the child. Reads the conversation tree from `state`.'],
  ['MessageSearchResults', 'journal/components.tsx', 'conversation', 'The "Messages" section of sidebar search: full-text hits grouped by conversation with **matched terms** highlighted, loading and failed states.'],
  // chrome
  ['HeaderShell', 'journal/components.tsx', 'chrome', 'The conversation header: back control, title with glyph and badge, subtitle (model · workdir · run state), the usage meters, and right-side controls. `mode` switches desktop vs compact phone layouts.'],
  ['UsageCluster', 'journal/components.tsx', 'chrome', 'The usage meter grid in the header: context window, 5h session, weekly limits, host CPU/RAM, each a short tag + bar coloured low / medium / high; stale host samples dim.'],
  ['ThemeToggle', 'journal/components.tsx', 'chrome', 'Icon button cycling the theme preference System -> Light -> Dark (persists to localStorage and sets data-theme on <html>).'],
  ['NewSessionSheet', 'journal/components.tsx', 'chrome', 'The "New session" sheet: pick an agent box, then a recent folder (or type a path), optional first message, Start. Loads agents and folders from the client.'],
  ['EditFileSheet', 'journal/components.tsx', 'chrome', 'The "Edit a file" sheet: choose a box and path, load the file, edit in a monospace editor, save with conflict detection.'],
  // tracker
  ['TrackerPane', 'journal/tracker/TrackerPane.tsx', 'tracker', 'The tracker main region: tabs for Inbox / Missions / Work, and the item or mission detail when one is selected. Everything reads from the client store (missions, inboxItems, trackerItem, trackerMission).'],
  ['ItemsInbox', 'journal/tracker/ItemsInbox.tsx', 'tracker', 'The decisions inbox: tracker items (questions, decisions, tasks) as ItemRows, with the Needs you / All filter and an empty state.'],
  ['ItemRow', 'journal/tracker/ItemRow.tsx', 'tracker', 'One full-width inbox row for a tracker item: kind glyph, #number + title, one-line body, then a meta line with provenance chip, mission chip, a single status token (Needs you in orange, With the agent, or the closed resolution) and comment count. The whole row is a button.'],
  ['ItemDetail', 'journal/tracker/ItemDetail.tsx', 'tracker', 'The full view of one tracker item: header with kind, #number, state and awaiting, markdown body, links, the comment thread with status-change entries, and the reply composer.'],
  ['MissionsList', 'journal/tracker/MissionsList.tsx', 'tracker', 'The missions list: open missions first with needs-you counts, open items, milestone count and the last milestone, then closed missions dimmed.'],
  ['MissionDetail', 'journal/tracker/MissionDetail.tsx', 'tracker', 'One mission: title, body, stats, the milestone trail (user_input milestones in orange), its open items, and the conversations working on it.'],
  ['WorkView', 'journal/tracker/WorkView.tsx', 'tracker', 'The Work tab: the loop store grouped by repo or domain as tracker rows (lead sentence, status chip, priority, owner, claim, age), one filter row (search, status, domain, grouping), and a loop detail with a next-step callout and the markdown description. Loads through a `WorkViewLoader` (use `fixtureWorkViewLoader`).'],
  ['ItemCard', 'journal/tracker/cards.tsx', 'tracker', 'The timeline card for a tracker item being created or closed: kind glyph, #number, title, status pill (orange border when it needs you). Click opens the item.'],
  ['ItemInlineNote', 'journal/tracker/cards.tsx', 'tracker', 'The compact one-line timeline note for a tracker item being commented on or reopened.'],
  ['MilestoneCard', 'journal/tracker/cards.tsx', 'tracker', 'The timeline card for a mission milestone (progress, or user_input in orange), linking to its mission.'],
  ['MissionNotice', 'journal/tracker/cards.tsx', 'tracker', 'The timeline notice for a mission being started or closed.'],
  ['TrackerGlyph', 'journal/tracker/glyphs.tsx', 'tracker', 'The single-source glyph for tracker kinds: question (orange), task (teal), decision (purple), mission open/closed (flag), milestone progress / user_input. Colour comes from a class, size from font-size (1em).'],
  ['NeedsYouBadge', 'journal/tracker/glyphs.tsx', 'tracker', 'The orange "needs you" count capsule (question-mark glyph + count, 99+ cap). Renders nothing at 0, so it can be dropped in unconditionally.'],
  // mobile
  ['MobileNav', 'journal/mobile-shell.tsx', 'mobile', 'The phone bottom tab bar (Chats / Tracker / Files) with the needs-you badge on Tracker. Only visible under the 700px breakpoint and hidden inside an open conversation (the composer owns the bottom edge).'],
  ['NavBadge', 'journal/mobile-shell.tsx', 'mobile', 'The small count pill used on the mobile Tracker tab and the header tracker button: exact to 99, then 99+; "N+" when the count is a lower bound.'],
  ['ConnectionStatus', 'journal/mobile-shell.tsx', 'mobile', 'The connection row in the Settings menu: status dot + Connected / Reconnecting / Offline, with a Reconnect button whenever not online.'],
  // files
  ['FilesPane', 'journal/files/FilesPane.tsx', 'files', 'The file explorer main region: breadcrumb path, toolbar (upload, new folder, show hidden), directory listing with kind icons, size and mtime, and a preview panel for the selected file. Write affordances appear only on writable roots.'],
  ['FilePreview', 'journal/files/preview/FilePreview.tsx', 'files', 'Preview dispatcher for one file: loads its metadata, then renders the matching previewer (markdown, code, image, PDF, audio/video, or generic) under a sticky header: file name + meta line on the left, and one equal-size icon-button cluster on the right (Edit when writable, Copy for text files, Download as the filled primary).'],
  ['CodePreview', 'journal/files/preview/CodePreview.tsx', 'files', 'Syntax-highlighted source preview with a language label. Copy lives in the FilePreview header, not here.'],
  ['MarkdownPreview', 'journal/files/preview/MarkdownPreview.tsx', 'files', 'Rendered markdown preview of a .md file, using the same MarkdownBody as messages.'],
  ['ImagePreview', 'journal/files/preview/ImagePreview.tsx', 'files', 'Image file preview, fit to the panel on a checkerboard-free canvas.'],
  ['PdfPreview', 'journal/files/preview/PdfPreview.tsx', 'files', 'PDF preview: pages painted to canvas (pdf.js in the app; a page-shaped stand-in in this bundle).'],
  ['MediaPreview', 'journal/files/preview/MediaPreview.tsx', 'files', 'Audio / video file preview with the native player controls.'],
  ['GenericPreview', 'journal/files/preview/GenericPreview.tsx', 'files', 'Fallback preview for binary files with no inline renderer: kind icon, name and meta, pointing at Download.'],
  ['TooLargePreview', 'journal/files/preview/TooLargePreview.tsx', 'files', 'The "too large to preview inline" note (download stays available above it).'],
  ['PreviewStatus', 'journal/files/preview/PreviewChrome.tsx', 'files', 'Status block for a preview: loading (spinner), error (with Retry) or empty.'],
  ['MediaError', 'journal/files/preview/PreviewChrome.tsx', 'files', 'Error state for image / PDF / media previews: message + Retry.'],
  ['DownloadControl', 'journal/files/preview/PreviewChrome.tsx', 'files', 'Standalone pill Download button (busy label while downloading, inline error below it). The preview header uses its own icon-button Download instead.'],
  ['FileWriteDialog', 'journal/files/FileWriteDialog.tsx', 'files', 'The confirm dialog for Files-pane writes: upload (with overwrite warning), new folder, rename/move, inline edit, and delete (moved to trash), with busy and error states.'],
  // media
  ['MediaViewer', 'journal/media-viewer.tsx', 'media', 'Full-screen media viewer overlay for images, SVGs and PDFs from the timeline: scrim, filename + counter, zoom / fit / reset, prev-next through the conversation\'s media, download and close.'],
  // foundations
  ['IconCatalog', 'ds/catalog.tsx', 'foundations', 'Reference card: every icon the app ships (src/journal/icons.tsx) and the tracker glyphs, labelled with their export names. Icons are stroke SVGs on currentColor.'],
  ['DesignTokens', 'ds/catalog.tsx', 'foundations', 'Reference card: the app\'s design tokens (CSS custom properties from shell.pcss) with live values in the current theme: colours, state layers, radii, spacing, shadows, type roles.'],
];

// Exported with .d.ts, no card (cfg.componentSrcMap null) - reasons in NOTES.md.
const CARDLESS = [
  ['MatronApp', 'journal/components.tsx'],
  ['ConnectionBanner', 'journal/mobile-shell.tsx'],
  ['MatronThemeProvider', 'ds/screens.tsx'],
];
// Non-component helpers the previews and the design agent use.
const HELPERS = [
  ['createFixtureClient', 'ds/fixtures.tsx'],
  ['createFixtureFilesApi', 'ds/fixtures.tsx'],
  ['fixtureConversations', 'ds/fixtures.tsx'],
  ['fixtureEvents', 'ds/fixtures.tsx'],
  ['fixtureSessionStatus', 'ds/fixtures.tsx'],
  ['fixtureMissions', 'ds/fixtures.tsx'],
  ['fixtureItems', 'ds/fixtures.tsx'],
  ['fixtureItemDetail', 'ds/fixtures.tsx'],
  ['fixtureMissionDetail', 'ds/fixtures.tsx'],
  ['fixtureWorkViewLoader', 'ds/fixtures.tsx'],
  ['fixtureFileEntries', 'ds/fixtures.tsx'],
  ['FIXTURE_FILES_ROOT', 'ds/fixtures.tsx'],
  ['FIXTURE_IMAGE_URL', 'ds/fixtures.tsx'],
  ['FIXTURE_CODE_SAMPLE', 'ds/fixtures.tsx'],
  ['FIXTURE_README_SAMPLE', 'ds/fixtures.tsx'],
  ['parseDiffPayload', 'journal/components.tsx'],
  ['buildUsageMeters', 'journal/components.tsx'],
  ['buildMediaCorpus', 'journal/media-viewer.tsx'],
];
const ICON_MODULES = ['journal/icons.tsx'];
const DISCRETE_GLYPHS = ['QuestionGlyph', 'TaskGlyph', 'DecisionGlyph', 'MissionGlyph', 'MilestoneGlyph',
  'CommentBubbleGlyph', 'JumpGlyph', 'ImagePlaceholderGlyph'];

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

const SHIMS = { 'connection.ts': 'connection.ts', 'database.ts': 'database.ts', 'pdf-render.ts': 'pdf-render.ts' };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'src'), { recursive: true });

// -- source copy (+ shims)
cpSync(join(ROOT, J), join(OUT, 'src/journal'), {
  recursive: true,
  filter: (p) => !/\/__tests__\/[^/]+\.(tsx?|md)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p),
});
for (const [target, shim] of Object.entries(SHIMS)) {
  if (!existsSync(join(ROOT, J, target))) throw new Error(`${J}/${target} is gone - update SHIMS in build-pkg.mjs`);
  cpSync(join(DS, 'shims', shim), join(OUT, 'src/journal', target));
}
cpSync(join(ROOT, 'src/contracts'), join(OUT, 'src/contracts'), { recursive: true });
cpSync(join(ROOT, 'res'), join(OUT, 'res'), { recursive: true });
// .svg imports: webpack emits them as asset URLs; the converter's esbuild loads .svg as a raw
// `data:image/svg+xml,<text>` URL whose double quotes break the app's `url("${logo}")` CSS masks
// (MsgAvatar rendered as a grey square). Rewrite each .svg import in the copy to a generated
// module exporting a base64 data URL instead.
for (const file of walkFiles(join(OUT, 'src/journal'))) {
  if (!/\.tsx?$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/import (\w+) from "([^"]+\.svg)";/g, (_m, id, spec) => {
    const svgPath = join(file, '..', spec);
    const b64 = readFileSync(join(ROOT, relative(OUT, svgPath))).toString('base64');
    const base = spec.slice(spec.lastIndexOf('/') + 1);
    writeFileSync(join(file, '..', `${base}.ts`), `export default "data:image/svg+xml;base64,${b64}";\n`);
    return `import ${id} from "./${base}.ts";`;
  });
  if (next !== text) writeFileSync(file, next);
}
cpSync(join(DS, 'src'), join(OUT, 'src/ds'), { recursive: true });

// -- tokens.json from the :root block of shell.pcss (DesignTokens card)
const shell = readFileSync(join(ROOT, J, 'shell.pcss'), 'utf8');
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(shell)?.[1];
if (!rootBlock) throw new Error('shell.pcss has no :root block - update build-pkg.mjs');
const groupOf = (n) =>
  /^--cpd-color-|^--mj-(selection|scrollbar|priority|summary|scrim|critical)/.test(n) ? 'color'
    : /^--cpd-state-/.test(n) ? 'state'
      : /^--cpd-radius-/.test(n) ? 'radius'
        : /^--cpd-space-/.test(n) ? 'space'
          : /^--cpd-shadow-/.test(n) ? 'shadow'
            : /^--cpd-font-(?!size)/.test(n) ? 'font'
              : /^--cpd-(dur|ease)/.test(n) ? 'motion' : 'other';
const tokenList = [...rootBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => ({ name: m[1], group: groupOf(m[1]) }));
writeFileSync(join(OUT, 'src/ds/tokens.json'), JSON.stringify(tokenList, null, 2) + '\n');

// -- package.json
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(join(OUT, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, module: 'index.mjs', types: 'types/index.d.ts',
}, null, 2) + '\n');

// -- barrel + .d.ts barrel: exactly the surface, cardless and helpers
const byModule = new Map();
for (const [name, mod] of [...SURFACE, ...CARDLESS, ...HELPERS]) {
  if (!byModule.has(mod)) byModule.set(mod, []);
  byModule.get(mod).push(name);
}
const barrel = [...byModule].map(([mod, names]) => `export { ${names.join(', ')} } from "./src/${mod}";`);
writeFileSync(join(OUT, 'index.mjs'), barrel.join('\n') + '\n');
writeFileSync(join(OUT, 'icons.mjs'),
  ICON_MODULES.map((m) => `export * from "./src/${m}";`).join('\n') +
  `\nexport { ${DISCRETE_GLYPHS.join(', ')} } from "./src/journal/tracker/glyphs.tsx";\n`);

// -- discovery stubs: cards/<group>/<Name>.tsx (group + doc; never compiled)
for (const [name, mod, group, doc] of SURFACE) {
  const dir = join(OUT, 'cards', group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.tsx`),
    `// discovery stub (design-sync): real source is src/${mod.replace(/^ds\//, '../.design-sync/src/')}\n` +
    `/**\n${doc.match(/.{1,96}(\s|$)/g).map((l) => ` * ${l.trimEnd()}`).join('\n')}\n */\n` +
    `export function ${name}() {}\n`);
}

// -- .d.ts via tsc on the copy (repo tsconfig; declaration-only; errors don't block emit)
writeFileSync(join(OUT, 'tsconfig.decl.json'), JSON.stringify({
  extends: '../../tsconfig.json',
  compilerOptions: {
    noEmit: false, declaration: true, emitDeclarationOnly: true, noEmitOnError: false,
    noUnusedLocals: false, incremental: false, outDir: 'types', rootDir: 'src',
    types: ['node'],
    // .ds-sync/node_modules (the converter's deps) sits closer to this copy than the repo's
    // node_modules and carries its own @types/react; pin React types to the repo's copy.
    baseUrl: '.',
    paths: {
      react: ['../../node_modules/@types/react/index.d.ts'],
      'react/*': ['../../node_modules/@types/react/*'],
      'react-dom': ['../../node_modules/@types/react-dom/index.d.ts'],
      'react-dom/*': ['../../node_modules/@types/react-dom/*'],
    },
  },
  include: ['src/journal/**/*.ts', 'src/journal/**/*.tsx', 'src/ds/**/*.ts', 'src/ds/**/*.tsx', 'src/contracts/**/*.ts'],
  exclude: ['src/journal/__tests__/**'],
}, null, 2) + '\n');
try {
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', join(OUT, 'tsconfig.decl.json')], { stdio: 'pipe' });
  writeFileSync(join(OUT, 'tsc.log'), '');
} catch (e) {
  const out = String(e.stdout ?? '') + String(e.stderr ?? '');
  const n = (out.match(/error TS\d+/g) ?? []).length;
  console.error(`  tsc: ${n} type error(s) reported (declarations still emitted) - see .ds-sync/pkg/tsc.log`);
  writeFileSync(join(OUT, 'tsc.log'), out);
}
writeFileSync(join(OUT, 'types/index.d.ts'),
  [...byModule].map(([mod, names]) => `export { ${names.join(', ')} } from "./${mod.replace(/\.tsx?$/, '')}";`).join('\n') + '\n');

// -- styles.css: the app's stylesheets, in the app's import order, through the same postcss pipeline as webpack
const req = createRequire(join(ROOT, 'package.json'));
const postcss = req('postcss');
const presetEnv = req('postcss-preset-env');
let css = ['shell', 'journal', 'tracker', 'work', 'mobile']
  .map((n) => `/* ---- src/journal/${n}.pcss ---- */\n` + readFileSync(join(ROOT, J, `${n}.pcss`), 'utf8'))
  .join('\n');
// The app pins html/body/#matron to the viewport with overflow:hidden (a full-screen shell).
// In the design canvas that clips every card and every scrolling design, so the rule is scoped
// to #matron (the app's mount node) here; html keeps its 15px root font-size and scrollbar colours.
const PIN = 'html,\nbody,\n#matron {\n    width: 100%;\n    height: 100%;\n    overflow: hidden;\n}';
if (!css.includes(PIN)) throw new Error('journal.pcss viewport-pin rule changed - update build-pkg.mjs');
css = css.replace(PIN, '#matron {\n    width: 100%;\n    height: 100%;\n    overflow: hidden;\n}');
// Alias tokens declared on :root as var(--other) compute ONCE at :root and inherit that value, so a
// [data-theme="dark"] subtree (MatronThemeProvider, MatronScreen) would keep the light value.
// In the app data-theme sits on <html> itself, so this never shows there. Re-declare every
// aliasing :root token on [data-theme] so it re-resolves inside a themed subtree.
const aliases = [...rootBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]*var\([^;]*);/gm)].map((m) => `    ${m[1]}: ${m[2]};`);
if (aliases.length) css += `\n/* design-sync: re-resolve aliasing tokens inside themed subtrees */\n[data-theme] {\n${aliases.join('\n')}\n}\n`;
const result = await postcss([presetEnv({ stage: 3, browsers: 'last 2 versions' })]).process(css, {
  from: join(OUT, 'input.css'), to: join(OUT, 'styles.css'),
});
writeFileSync(join(OUT, 'styles.css'), result.css);

const nStub = SURFACE.length;
console.error(`  build-pkg: ${nStub} cards, ${CARDLESS.length} cardless, ${tokenList.length} tokens -> ${relative(ROOT, OUT)} (styles.css ${(result.css.length / 1024).toFixed(0)} KB)`);
