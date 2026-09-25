# Matron web: conventions for building with this design system

Matron is the operator's web client for AI agent sessions: a journal of agent conversations
(messages, tool output, diffs, prompts, subagents), a tracker (questions / decisions / tasks,
missions, milestones, Work) and a file explorer. Warm-neutral surfaces, one teal accent, orange
only for "needs you". Every component is real app code from `src/journal/`, on `window.MatronWeb`.

## Setup

- Wrap the tree in `<MatronThemeProvider>` (`theme="light"` default or `"dark"`; `padding`;
  `surface="app" | "default"`). Tokens key on `[data-theme]`, so a nested dark provider makes a
  dark region inside a light page.
- Type: Inter 400/600 on a 15px root, Fira Code for code and meters. Use the role tokens:
  `font: var(--cpd-font-body)`, `var(--cpd-font-title)`, `var(--cpd-font-meta)`.
- Styling is plain CSS classes (`mj_*`, `mx_*`) in `styles.css`, not utilities. Use components
  where they exist; build new layout with inline styles from tokens, never raw hex.
- Phone layout is `@media (max-width: 700px)`: design phone screens in a ~390px viewport, not
  a narrow box on a wide page.

## Tokens (DesignTokens card)

- Surfaces: `--cpd-color-bg-app` (page), `--cpd-color-bg-canvas-default` (panels),
  `--cpd-color-bg-canvas-raised`, `--cpd-color-bg-subtle-primary`, `--cpd-color-bg-self-bubble`.
- Ink: `--cpd-color-text-primary` / `-secondary` / `-tertiary`,
  `--cpd-color-text-action-accent` (teal actions), `--cpd-color-text-critical-primary`.
- Lines: `--cpd-color-border-subtle`, `--cpd-color-border-strong`; shadows
  (`--cpd-shadow-sm|md|lg`) only for overlays.
- Radius `--cpd-radius-xs..xl`, `--cpd-radius-pill`; spacing `--cpd-space-1x` (4px) to `-12x`.

## Which component for what

- Screens: `MatronScreen` (desktop) / `MatronMobileScreen` (phone) render the whole app;
  `screen` = chat, subagent, list, files, files-preview, tracker-missions, tracker-mission,
  tracker-inbox, tracker-item, tracker-work, search, upload, offline, signed-out.
- Conversation: `EventContent` (any timeline event; wrap in `.markdown-body`), `MarkdownBody`
  (wrap in `.mj_Markdown`), `DiffCard`, `ToolStream`, `QueuedReleaseCard`, `PinnedSummary`,
  `SubagentStrip`, `MessageSearchResults`.
- Chrome: `HeaderShell`, `UsageCluster`, `ThemeToggle`, `NewSessionSheet`, `EditFileSheet`.
  Phone: `MobileNav`, `NavBadge`, `ConnectionStatus`.
- Tracker: `TrackerPane`, `ItemsInbox`, `ItemRow`, `ItemDetail`, `MissionsList`,
  `MissionDetail`, `WorkView`, `ItemCard`, `ItemInlineNote`, `MilestoneCard`, `MissionNotice`,
  `TrackerGlyph`, `NeedsYouBadge`.
- Files: `FilesPane`, `FilePreview` (+ `CodePreview`, `MarkdownPreview`, `ImagePreview`,
  `PdfPreview`, `MediaPreview`, `GenericPreview`, `TooLargePreview`), `PreviewStatus`,
  `MediaError`, `DownloadControl`, `FileWriteDialog`. Media: `MediaViewer`.
- Icons: the IconCatalog card lists every export (`SearchIcon`, `FolderIcon`, `SendIcon`,
  `QuestionGlyph`, ...): stroke SVGs on `currentColor`. No icon library; don't invent names.

## Data

Components take real app shapes (`TrackerItem`, `Mission`, `JournalEvent`, `ClientState`) or a
`client`. Start from the fixtures and spread-override: `fixtureItems`, `fixtureItemDetail`,
`fixtureMissions`, `fixtureMissionDetail`, `fixtureEvents`, `fixtureConversations`,
`fixtureSessionStatus`, `fixtureWorkViewLoader`, `createFixtureFilesApi()`. For `client`
(and `state`) use `createFixtureClient({ screen })` and `client.getSnapshot()`; it never
connects to anything.

```jsx
const { MatronThemeProvider, ItemRow, NeedsYouBadge, fixtureItems } = window.MatronWeb;

<MatronThemeProvider theme="dark">
  <div style={{ display: "flex", gap: "var(--cpd-space-2x)", font: "var(--cpd-font-title)" }}>
    Decisions <NeedsYouBadge count={2} />
  </div>
  <ItemRow item={{ ...fixtureItems[0], title: "Ship the phone tracker this week?" }} onOpen={() => {}} />
</MatronThemeProvider>
```
