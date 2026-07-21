---
title: "Web journal client — rich diff cards for file edits"
status: draft
date: 2026-07-20
loop: 455
owner: easelyte
approach: "A — faithful port of apple's DiffCard (2026-07-14-diff-cards-design.md), including the viewer_url file-open link"
rejected_alternatives:
  - "B (minimal: filename link + counts prepended to the existing <pre>): ~15 lines, delivers the click-to-open-file win but skips collapse, prefix-coloring, and the new-file badge — not real parity, re-opens the gap later."
  - "C (DiffCard + build the viewer-WebSocket LiveOutputCard for live output): rejected. Dan's own 2026-07-14-tool-stream-overlay-design.md explicitly FROZE the legacy viewer-WebSocket path ('The legacy LiveOutputEvent/LiveOutputSession path stays untouched'; non-goal: 'Any change to the legacy viewer-WebSocket path') and moved live output to in-band tool_stream ephemerals — which web ALREADY renders at parity (ToolStreamState append/sync/end, ToolStream tile components.tsx:779; durable tool_output blob fetch ToolOutput components.tsx:554). Building a web viewer-socket consumer would port toward deprecated code. See §2."
related_principles:
  - "P1 UI hiding ≠ authorization — the viewer_url link is a real capability the bridge grants (HMAC-signed) or withholds (null); the client renders a link ONLY when the bridge supplied one, never fabricates or reconstructs it."
  - "P3 Fail-visible — a missing/empty diff string renders a header-only card, not a blank; a null viewer_url renders plain filename text, not a dead link."
  - "P8 Parse-don't-validate at the boundary — parseDiffPayload turns the untyped EventPayload bag into one typed DiffCardData shape at the render boundary; the component never re-reads raw payload keys."
  - "P15 Data egress needs permission — the viewer link opens files.easelyte.ai in a new tab; the viewer re-validates the HMAC server-side, so the client adds no auth material and uses rel=noopener noreferrer (no window.opener handle, no referrer leak)."
  - "P35 Code-coordinate citations grep-confirmed at write time — web file:line refs verified against the implementation base upstream/main cf7646f (the branch D builds on, NOT fork main); bridge refs against bridge-journal journal-deploy."
constraint: "components.tsx and client.ts must NOT be split — matron-web stays structurally aligned with Matronhq/matron-web upstream (memory: project_matron_web_stays_dan_upstream_aligned). The DiffCard component + parseDiffPayload helper land INLINE in components.tsx; styles in journal.pcss; one small icon in icons.tsx."
---

# Web journal client — rich diff cards for file edits

## 1. Problem & goal

When the agent edits or writes a file, the bridge publishes a structured `diff` journal event carrying the full edit context. The web client throws almost all of it away — its `diff` case (`components.tsx:687`) is a bare dump:

```jsx
case "diff":
    return <pre className="mj_Diff">{asString(event.payload.diff, asString(event.payload.patch, JSON.stringify(event.payload, null, 2)))}</pre>;
```

This drops the **`viewer_url`** (the only way to open the *full* file Claude edited, not just the shown hunk), the filename, the `added`/`removed` counts, the `new_file` badge, and the `truncated` notice. The apple client renders all of it as a rich `DiffCard`, filename linked to the signed viewer.

Goal: reach parity with apple's `DiffCard` (Dan's spec `matron-apple docs/superpowers/specs/2026-07-14-diff-cards-design.md`) — a structured card with a filename header linking to the viewer, green/red prefix-colored diff, snippet-collapsed to 12 lines, additions/removals counts, and a new-file badge. This is the one genuine, current gap in loop #455 (see §2 for why the "live-output" half of #455 is obsolete).

## 2. Scope correction: the "live-output" half of #455 is already at parity

Loop #455 was framed as "viewer_url file-open links **+ live_output** are dropped." Verified against the journal bridge (`/opt/matron/bridge-journal`, `journal-deploy`):

- `viewer_url` is emitted at **exactly one bridge site** — `buildEditDiffPayload` for diff/edit events (`index.js:719`, `generateFileLink(absPath, session.workdir)`). It is NOT attached to tool output, files, or anything else (`grep -n viewer_url index.js` → one *assignment* at line 719; the only other match, line 4069, is the comment noting its deliberate absence from live output).
- Live tool output no longer uses a viewer WebSocket. `sendLiveOutputEvent` (`index.js:4064`) comment: *"No viewer_url / expires_at anywhere — live output rides the journal protocol."* It rides in-band `tool_stream` ephemerals + a durable `tool_output` completion (tee-log tail uploaded as a media blob).
- **Web already renders both** at parity: `ToolStream` tile (`components.tsx:779`, fed by `ToolStreamState` append/sync/end, 64KiB cap) and `ToolOutput` with `blob_ref` fetch (`components.tsx:554`).
- Apple's `LiveOutputCard` (viewer-WS) only triggers on a `tool_output` carrying `viewer_url` — which this bridge never emits — so apple falls through to the same `tool_stream` path web runs. Dan's `2026-07-14-tool-stream-overlay-design.md` froze the viewer-WS path as legacy.

**Therefore this spec covers only the diff card.** No client viewer-WebSocket, no file/tool_output open-links.

## 3. Wire contract (what the bridge sends — web already receives it)

`EventPayload` is `Record<string, unknown>` (`types.ts:55`), so the full payload already arrives on web's frames untouched; the `diff` case just ignores most keys. The payload shape (bridge `buildEditDiffPayload`, `index.js:710-729`; contract mirrors apple spec §2):

```json
{
  "type": "diff",
  "file_path": "/abs/path/to/file.ts",
  "display_path": "src/journal/file.ts",
  "viewer_url": "https://files.easelyte.ai/view?token=…",
  "tool": "Edit",
  "label": null,
  "diff": "@@ -10,3 +10,4 @@\n-old\n+new\n+added\n context",
  "added": 12,
  "removed": 3,
  "truncated": false,
  "new_file": false
}
```

- `viewer_url`: HMAC-signed link, or **`null`** when `HMAC_SECRET`/`VIEWER_BASE_URL` are unconfigured or the file-link gate denied it (`index.js:328-345`). Links expire; an expired link opens the viewer's own error page — no client handling (accepted, matches apple).
- `display_path`: path as typed in the tool input (relative or absolute). The card header shows its last component.
- `label`: subagent label string, `null` for main-agent edits.
- **Legacy bare shape** `{ diff: "…" }` (older events, or any pre-rich payload): all metadata absent. Must render via the SAME path with nils → header-only-with-diff, no link/counts/badge.

## 4. Current web-client seams (verified against upstream/main cf7646f, `src/journal/`)

- **Render dispatch** — `EventContent` (`components.tsx:663`) switches on `event.type`; `case "diff"` at `components.tsx:687`. Sibling cases (`tool_output`→`ToolOutput` 554, `image` 696, `file` 704) show the component-extraction pattern to follow.
- **Coercion helpers** — `asString` (imported, `components.tsx:34`) and `formatBytes` (`components.tsx:120`) are the house coercers for the untyped bag.
- **Card chrome to mirror** — `ToolOutput` (`components.tsx:554`) uses `mj_ToolCard` surface + a `!`/`›_` status glyph + `<code>` command + a `Load full output` button. `DiffCard` reuses that visual vocabulary but toggles line-count with React state (native `<details>` hides ALL body; the diff card must keep 12 lines visible when collapsed).
- **Icons** — `icons.tsx` exports small inline-SVG components (`SettingsIcon`, `ComposeIcon`, `AttachmentIcon`, …) sharing an `IconProps` signature (`icons.tsx:10`); no file/doc icon yet — this spec adds one (`FileEditIcon`).
- **Styles** — the current bare `.mj_Diff` lives at `journal.pcss:402` (+ dark override `:634`); replaced by the `mj_DiffCard*` classes below.
- **Event types** — `diff` is already in `MESSAGE_EVENT_TYPES` (`types.ts:11`); no type-set change.

## 5. Design

### 5.1 `parseDiffPayload(payload: EventPayload): DiffCardData` (exported)

A pure module-level function in `components.tsx` (beside `EventContent`), **`export`ed** so `diff-card-test.ts` can import it directly (§6). It reads the untyped bag into a typed shape with **presence checks** (not bare `asString`, which returns `""` on absence — see the optional-fields bullet); every field independently optional:

```ts
interface DiffCardData {
    diff: string;              // payload.diff, else payload.patch (legacy fallback), else "" → header-only
    displayPath?: string;
    filePath?: string;
    viewerUrl?: string;        // undefined when null/absent/non-https → plain filename, no link
    tool?: string;
    label?: string;
    added?: number;            // undefined when absent → count hidden
    removed?: number;
    truncated: boolean;        // default false
    newFile: boolean;          // default false
}
```

- `diff`: `asString(payload.diff)`, and when that is empty, `asString(payload.patch)` — **preserving the current `diff ?? patch` fallback** (`components.tsx:687`) so a legacy `{patch:"…"}` event still renders; `""` only when both are absent.
- **Optional string fields** (`displayPath`, `filePath`, `tool`, `label`): presence-checked, NOT `asString` — `typeof payload.x === "string" && payload.x ? payload.x : undefined`. `asString` returns `""` on absence, which would (a) fail the §6 "all metadata undefined" acceptance and (b) break `displayPath ?? filePath` (nullish coalescing does not fall through on `""`).
- `viewerUrl`: set ONLY when `payload.viewer_url` is a non-empty string that parses via `new URL()` with `protocol === "https:"` — otherwise `undefined` (plain filename, no link). Rejects a forged/future event injecting a relative path, `javascript:`/`data:` scheme, or non-https origin as the trusted filename action (P1/P8/P15 — never fabricated, parse-at-boundary, scheme-bounded).
- `added`/`removed`: set only when the payload value is a `number` (not coerced from strings).
- `filename` is derived in the component: last path component of `displayPath ?? filePath`, falling back to `"file"`.

### 5.2 `DiffCard` component (exported)

```tsx
export function DiffCard({ data }: { data: DiffCardData }): React.ReactElement
```

React `const [expanded, setExpanded] = useState(false)`.

Let `lineCount` = number of rendered diff lines (the trailing-newline-trimmed split defined under **Body**); `expandable` = `lineCount > 12`. The expand affordance is shown ONLY when `expandable` — a header-only card (empty diff) or a diff of ≤12 lines has no chevron and no "more" row (nothing to expand; a dead toggle would be a P3 fail-visible violation).

**Header row** (`mj_DiffCard_header`):
- chevron button, rendered ONLY when `expandable` (`aria-expanded`, toggles `expanded`) — a distinct hit target
- `<FileEditIcon aria-hidden />`
- **filename**: when `data.viewerUrl` → `<a className="mj_DiffCard_filename mj_DiffCard_link" href={data.viewerUrl} target="_blank" rel="noopener noreferrer">{filename}</a>`; else a plain `<span className="mj_DiffCard_filename">{filename}</span>` (P3 — no dead link). No `stopPropagation`: the header row carries no click handler (the chevron is the sole expand trigger, a distinct hit target), so the link needs no propagation guard.
- dimmed `data.label` when present (`mj_DiffCard_label`)
- "new file" badge when `data.newFile` (`mj_DiffCard_badge`)
- `+{added}` / `−{removed}` counts (`mj_DiffCard_added` / `_removed`), each rendered only when its value is a number
- truncated marker "…" (title="diff truncated") when `data.truncated`

**Body** (`mj_DiffCard_body`, monospace):
- Lines = `data.diff` with a single trailing newline stripped (`data.diff.replace(/\n$/, "")`) then split on `\n` — so a newline-terminated diff does not yield a phantom trailing empty line (which would inflate `lineCount` and show a spurious "+1 more lines"). `lineCount`/`expandable` are computed from THIS trimmed array. Each line → `<div>` with a class by first char: `+`→`mj_DiffLine_add`, `-`→`mj_DiffLine_del`, `@`(`@@`)→`mj_DiffLine_hunk`, else `mj_DiffLine_ctx`.
- Collapsed (default): first **12** lines; when `expandable`, a dimmed `mj_DiffCard_more` row "+N more lines" (clicking it, or the chevron, expands). When not `expandable`, all lines already show and there is no "more" row. Expanded: all lines (bridge already caps at 400 — apple spec §1).
- When `data.truncated`, the last row reads "… diff truncated" (`mj_DiffCard_truncated`).
- Empty `diff` ("") → no body, header-only card.

**`case "diff"`** becomes:
```jsx
case "diff":
    return <DiffCard data={parseDiffPayload(event.payload)} />;
```

### 5.3 Styling (`journal.pcss`)

Replace `.mj_Diff` (402, 634) with `mj_DiffCard*` reusing existing palette tokens so light/dark both work (mirrors `mj_ToolCard`):
- `mj_DiffCard` (code-bg surface, rounded 8, same as tool card), `mj_DiffCard_header` (flex row, gap, wrap), `mj_DiffCard_filename` (medium weight) + `mj_DiffCard_link` (accent color, hover underline, focus-visible ring), `mj_DiffCard_label` (dimmed), `mj_DiffCard_badge` (small pill), `mj_DiffCard_added` (green) / `_removed` (red), `mj_DiffCard_body` (monospace, **`white-space: pre`** — required so diff indentation/tabs/repeated spaces are preserved; a plain `<div>` collapses whitespace and corrupts the patch — plus horizontal scroll), `mj_DiffLine_add` (green tint) / `_del` (red tint) / `_hunk` (dimmed) / `_ctx` (primary), `mj_DiffCard_more` / `_truncated` (dimmed, `mj_TextButton`-like for the more-row).

### 5.4 Icon (`icons.tsx`)

Add one small inline-SVG `FileEditIcon` matching the existing icon component signature (`IconProps` → 16px SVG), used in the DiffCard header.

## 6. Testing (`test/unit-tests/journal/diff-card-test.ts`)

Per the matron-web jest convention (memory `reference_matron_web_jest_convention`): `journal/` subdir + **hyphen** `-test.ts` suffix, `.ts` even for a `.tsx` component, import depth `../../../src/journal/...`, run `node_modules/.bin/jest`.

Both `parseDiffPayload` and `DiffCard` are exported (§5.1/§5.2), so the test imports them directly.

- **parseDiffPayload:**
  - rich payload → full DiffCardData;
  - bare `{diff:"…"}` → diff set + `displayPath`/`filePath`/`tool`/`label` all **`undefined`** (not `""`) + truncated/newFile false;
  - **patch fallback (B1):** `{patch:"@@ …"}` with no `diff` → `diff` = the patch content (legacy events still render, not header-only);
  - missing/empty diff (and no patch) → `""`; non-number `added`/`removed` (e.g. string) → undefined;
  - `viewer_url: null` and `viewer_url: ""` → `viewerUrl` undefined;
  - **scheme guard (M1):** `viewer_url:"javascript:alert(1)"`, `"data:text/html,…"`, and a relative `"/view?token=x"` → `viewerUrl` undefined; a valid `https://…` → set;
  - **empty-string fallthrough:** `display_path:""` with `file_path:"a/b.ts"` → filename resolves to `b.ts` (empty `displayPath` is `undefined`, so `?? filePath` fires).
- **DiffCard render (jsdom):**
  - filename = last component of `display_path` (falls back to `file_path`, then `"file"`);
  - link present iff `viewerUrl` set AND carries `target="_blank"` + `rel="noopener noreferrer"`; **guard test:** `viewer_url:null` → filename is a plain `<span>`, no `<a>` (P1/P15 boundary);
  - counts hidden when undefined; both shown when numbers;
  - new-file badge iff `new_file`;
  - collapsed shows ≤12 diff lines + a "more" row; expanding (chevron click) shows all;
  - **not-expandable guard:** a diff of ≤12 lines renders no chevron and no "more" row (all lines shown, no dead toggle); an empty diff renders header-only with no chevron;
  - **terminal-newline (M2):** a 12-line diff ending in `"\n"` → `expandable` false, no chevron, no "more" row (the trailing empty entry is trimmed, so `lineCount` is 12 not 13);
  - **whitespace (B2):** a diff line with leading indentation renders inside `mj_DiffCard_body` (the class carrying `white-space: pre`) with its leading spaces preserved in `textContent`;
  - `truncated:true` → "… diff truncated" tail;
  - empty diff → header renders, no body.

## 7. Loop #455 closure note (on ship)

Close #455 with a `close_reason_doc` recording: the viewer-WebSocket live-output half is obsolete on our stack (Dan froze it per `2026-07-14-tool-stream-overlay-design.md`; `tool_stream` is the live-output plan and web is already at parity — §2); delivered scope = the structured DiffCard + `viewer_url` file-open link per apple's `2026-07-14-diff-cards-design.md`.

## 8. Out of scope (YAGNI)

- Viewer-WebSocket `LiveOutputCard` / `viewerUrlToWsUrl` (§2 — deprecated path, web already at parity via tool_stream).
- File / tool_output open-links (bridge emits `viewer_url` on `diff` only).
- Any `components.tsx` / `client.ts` split (upstream-alignment constraint).
- Diff syntax highlighting beyond +/−/@@ prefix coloring (apple parity is prefix-color only).

## 9. Acceptance

1. A rich `diff` event renders a card: linked filename (opens viewer in a new tab), `+N −M` counts, new-file badge when applicable, prefix-colored body collapsed to 12 lines, expandable, truncated tail when truncated.
2. A `diff` event with `viewer_url:null` renders the same card with a plain-text filename (no `<a>`).
3. A legacy bare `{diff:"…"}` event renders a header-only-with-diff card (no link/counts/badge) via the same path; a legacy `{patch:"…"}` event (no `diff`) renders its patch content, not a blank card.
4. A `diff` event whose `viewer_url` is a non-https/relative/`javascript:` string renders a plain-text filename (no `<a>`) — no arbitrary destination is ever presented as the viewer link.
5. Diff whitespace (indentation, tabs, repeated spaces) is preserved verbatim in the rendered body; a newline-terminated diff does not show a spurious "+1 more lines".
6. New unit test file passes under `node_modules/.bin/jest`; existing `components-test.ts` unaffected.
7. `components.tsx` and `client.ts` are not split; changes are inline.
