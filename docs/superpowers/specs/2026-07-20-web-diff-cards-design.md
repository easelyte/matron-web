---
title: "Web journal client — rich diff cards for file edits"
status: draft
date: 2026-07-20
loop: 455
owner: easelyte
approach: "A — faithful port of apple's DiffCard (2026-07-14-diff-cards-design.md), including the viewer_url file-open link"
rejected_alternatives:
  - "B (minimal: filename link + counts prepended to the existing <pre>): ~15 lines, delivers the click-to-open-file win but skips collapse, prefix-coloring, and the new-file badge — not real parity, re-opens the gap later."
  - "C (DiffCard + build the viewer-WebSocket LiveOutputCard for live output): rejected. Dan's own 2026-07-14-tool-stream-overlay-design.md explicitly FROZE the legacy viewer-WebSocket path ('The legacy LiveOutputEvent/LiveOutputSession path stays untouched'; non-goal: 'Any change to the legacy viewer-WebSocket path') and moved live output to in-band tool_stream ephemerals — which web ALREADY renders at parity (ToolStreamState append/sync/end, ToolStream tile components.tsx:1402; durable tool_output blob fetch ToolOutput components.tsx:1150). Building a web viewer-socket consumer would port toward deprecated code. See §2."
related_principles:
  - "P1 UI hiding ≠ authorization — the viewer_url link is a real capability the bridge grants (HMAC-signed) or withholds (null); the client renders a link ONLY when the bridge supplied one, never fabricates or reconstructs it."
  - "P3 Fail-visible — a missing/empty diff string renders a header-only card, not a blank; a null viewer_url renders plain filename text, not a dead link."
  - "P8 Parse-don't-validate at the boundary — parseDiffPayload turns the untyped EventPayload bag into one typed DiffCardData shape at the render boundary; the component never re-reads raw payload keys."
  - "P15 Data egress needs permission — the viewer link opens files.easelyte.ai in a new tab; the viewer re-validates the HMAC server-side, so the client adds no auth material and uses rel=noopener noreferrer (no window.opener handle, no referrer leak)."
  - "P35 Code-coordinate citations grep-confirmed at write time — all file:line refs verified against HEAD 7774bc3."
constraint: "components.tsx and client.ts must NOT be split — matron-web stays structurally aligned with Matronhq/matron-web upstream (memory: project_matron_web_stays_dan_upstream_aligned). The DiffCard component + parseDiffPayload helper land INLINE in components.tsx; styles in journal.pcss; one small icon in icons.tsx."
---

# Web journal client — rich diff cards for file edits

## 1. Problem & goal

When the agent edits or writes a file, the bridge publishes a structured `diff` journal event carrying the full edit context. The web client throws almost all of it away — its `diff` case (`components.tsx:1300`) is a bare dump:

```jsx
case "diff":
    return <pre className="mj_Diff">{asString(event.payload.diff, asString(event.payload.patch, JSON.stringify(event.payload, null, 2)))}</pre>;
```

This drops the **`viewer_url`** (the only way to open the *full* file Claude edited, not just the shown hunk), the filename, the `added`/`removed` counts, the `new_file` badge, and the `truncated` notice. The apple client renders all of it as a rich `DiffCard`, filename linked to the signed viewer.

Goal: reach parity with apple's `DiffCard` (Dan's spec `matron-apple docs/superpowers/specs/2026-07-14-diff-cards-design.md`) — a structured card with a filename header linking to the viewer, green/red prefix-colored diff, snippet-collapsed to 12 lines, additions/removals counts, and a new-file badge. This is the one genuine, current gap in loop #455 (see §2 for why the "live-output" half of #455 is obsolete).

## 2. Scope correction: the "live-output" half of #455 is already at parity

Loop #455 was framed as "viewer_url file-open links **+ live_output** are dropped." Verified against the journal bridge (`/opt/matron/bridge-journal`, `journal-deploy`):

- `viewer_url` is emitted at **exactly one bridge site** — `buildEditDiffPayload` for diff/edit events (`index.js:719`, `generateFileLink(absPath, session.workdir)`). It is NOT attached to tool output, files, or anything else (`grep viewer_url: index.js` → single hit).
- Live tool output no longer uses a viewer WebSocket. `sendLiveOutputEvent` (`index.js:4064`) comment: *"No viewer_url / expires_at anywhere — live output rides the journal protocol."* It rides in-band `tool_stream` ephemerals + a durable `tool_output` completion (tee-log tail uploaded as a media blob).
- **Web already renders both** at parity: `ToolStream` tile (`components.tsx:1402`, fed by `ToolStreamState` append/sync/end, 64KiB cap) and `ToolOutput` with `blob_ref` fetch (`components.tsx:1150`).
- Apple's `LiveOutputCard` (viewer-WS) only triggers on a `tool_output` carrying `viewer_url` — which this bridge never emits — so apple falls through to the same `tool_stream` path web runs. Dan's `2026-07-14-tool-stream-overlay-design.md` froze the viewer-WS path as legacy.

**Therefore this spec covers only the diff card.** No client viewer-WebSocket, no file/tool_output open-links.

## 3. Wire contract (what the bridge sends — web already receives it)

`EventPayload` is `Record<string, unknown>` (`types.ts:56`), so the full payload already arrives on web's frames untouched; the `diff` case just ignores most keys. The payload shape (bridge `buildEditDiffPayload`, `index.js:706-724`; contract mirrors apple spec §2):

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

## 4. Current web-client seams (verified against HEAD 7774bc3, `src/journal/`)

- **Render dispatch** — `EventContent` (`components.tsx:1259`) switches on `event.type`; `case "diff"` at `components.tsx:1300`. Sibling cases (`tool_output`→`ToolOutput` 1150, `image`, `file` 1318) show the component-extraction pattern to follow.
- **Coercion helpers** — `asString` (imported, `components.tsx:45`) and `formatBytes` (`components.tsx:139`) are the house coercers for the untyped bag.
- **Card chrome to mirror** — `ToolOutput` (`components.tsx:1150`) uses `mj_ToolCard` surface + a `!`/`›_` status glyph + `<code>` command + a `Load full output` button. `DiffCard` reuses that visual vocabulary but toggles line-count with React state (native `<details>` hides ALL body; the diff card must keep 12 lines visible when collapsed).
- **Icons** — `icons.tsx` exports small inline-SVG components (`ArchiveIcon`, `PinIcon`, …); no file/doc icon yet — this spec adds one (`FileEditIcon`).
- **Styles** — the current bare `.mj_Diff` lives at `journal.pcss:958` (+ dark override `:1222`); replaced by the `mj_DiffCard*` classes below.
- **Event types** — `diff` is already in `MESSAGE_EVENT_TYPES` (`types.ts:11`); no type-set change.

## 5. Design

### 5.1 `parseDiffPayload(payload: EventPayload): DiffCardData`

A pure module-level function in `components.tsx` (beside `EventContent`). Reads the bag into a typed shape using `asString` and numeric coercion; every field independently optional:

```ts
interface DiffCardData {
    diff: string;              // "" when missing → header-only card
    displayPath?: string;
    filePath?: string;
    viewerUrl?: string;        // undefined when null/absent → plain filename, no link
    tool?: string;
    label?: string;
    added?: number;            // undefined when absent → count hidden
    removed?: number;
    truncated: boolean;        // default false
    newFile: boolean;          // default false
}
```

- `viewerUrl` is set ONLY when `payload.viewer_url` is a non-empty string (P1/P15 — never fabricated).
- `added`/`removed` set only when the payload value is a `number` (not coerced from strings).
- `filename` is derived in the component: last path component of `displayPath ?? filePath`, falling back to `"file"`.

### 5.2 `DiffCard` component

```tsx
function DiffCard({ data }: { data: DiffCardData }): React.ReactElement
```

React `const [expanded, setExpanded] = useState(false)`.

**Header row** (`mj_DiffCard_header`):
- chevron button (`aria-expanded`, toggles `expanded`) — a distinct hit target
- `<FileEditIcon aria-hidden />`
- **filename**: when `data.viewerUrl` → `<a className="mj_DiffCard_filename mj_DiffCard_link" href={data.viewerUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{filename}</a>`; else a plain `<span className="mj_DiffCard_filename">{filename}</span>` (P3 — no dead link)
- dimmed `data.label` when present (`mj_DiffCard_label`)
- "new file" badge when `data.newFile` (`mj_DiffCard_badge`)
- `+{added}` / `−{removed}` counts (`mj_DiffCard_added` / `_removed`), each rendered only when its value is a number
- truncated marker "…" (title="diff truncated") when `data.truncated`

**Body** (`mj_DiffCard_body`, monospace):
- `data.diff` split on `\n` into lines; each line → `<div>` with a class by first char: `+`→`mj_DiffLine_add`, `-`→`mj_DiffLine_del`, `@`(`@@`)→`mj_DiffLine_hunk`, else `mj_DiffLine_ctx`.
- Collapsed (default): first **12** lines; if more exist, a dimmed `mj_DiffCard_more` row "+N more lines" (clicking it, or the chevron, expands). Expanded: all lines (bridge already caps at 400 — apple spec §1).
- When `data.truncated`, the last row reads "… diff truncated" (`mj_DiffCard_truncated`).
- Empty `diff` ("") → no body, header-only card.

**`case "diff"`** becomes:
```jsx
case "diff":
    return <DiffCard data={parseDiffPayload(event.payload)} />;
```

### 5.3 Styling (`journal.pcss`)

Replace `.mj_Diff` (958, 1222) with `mj_DiffCard*` reusing existing palette tokens so light/dark both work (mirrors `mj_ToolCard`):
- `mj_DiffCard` (code-bg surface, rounded 8, same as tool card), `mj_DiffCard_header` (flex row, gap, wrap), `mj_DiffCard_filename` (medium weight) + `mj_DiffCard_link` (accent color, hover underline, focus-visible ring), `mj_DiffCard_label` (dimmed), `mj_DiffCard_badge` (small pill), `mj_DiffCard_added` (green) / `_removed` (red), `mj_DiffCard_body` (monospace, horizontal scroll), `mj_DiffLine_add` (green tint) / `_del` (red tint) / `_hunk` (dimmed) / `_ctx` (primary), `mj_DiffCard_more` / `_truncated` (dimmed, `mj_TextButton`-like for the more-row).

### 5.4 Icon (`icons.tsx`)

Add one small inline-SVG `FileEditIcon` matching the existing icon component signature (`IconProps` → 16px SVG), used in the DiffCard header.

## 6. Testing (`test/unit-tests/journal/diff-card-test.ts`)

Per the matron-web jest convention (memory `reference_matron_web_jest_convention`): `journal/` subdir + **hyphen** `-test.ts` suffix, `.ts` even for a `.tsx` component, import depth `../../../src/journal/...`, run `node_modules/.bin/jest`.

- **parseDiffPayload:** rich payload → full DiffCardData; bare `{diff:"…"}` → diff set + all metadata undefined + truncated/newFile false; missing/empty diff → `""`; non-number `added`/`removed` (e.g. string) → undefined; `viewer_url: null` and `viewer_url: ""` → `viewerUrl` undefined.
- **DiffCard render (jsdom):**
  - filename = last component of `display_path` (falls back to `file_path`, then `"file"`);
  - link present iff `viewerUrl` non-null AND carries `target="_blank"` + `rel="noopener noreferrer"`; **guard test:** `viewer_url:null` → filename is a plain `<span>`, no `<a>` (P1/P15 boundary);
  - counts hidden when undefined; both shown when numbers;
  - new-file badge iff `new_file`;
  - collapsed shows ≤12 diff lines + a "more" row; expanding (chevron click) shows all;
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
3. A legacy bare `{diff:"…"}` event renders a header-only-with-diff card (no link/counts/badge) via the same path.
4. New unit test file passes under `node_modules/.bin/jest`; existing `components-test.ts` unaffected.
5. `components.tsx` and `client.ts` are not split; changes are inline.
