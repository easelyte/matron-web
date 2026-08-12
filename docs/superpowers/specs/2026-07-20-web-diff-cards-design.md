---
title: "Web journal client — rich diff cards for file edits"
status: draft
date: 2026-07-20
approach: "A — faithful port of apple's DiffCard (2026-07-14-diff-cards-design.md), including the viewer_url file-open link"
rejected_alternatives:
  - "B (minimal: filename link + counts prepended to the existing <pre>): ~15 lines, delivers the click-to-open-file win but skips collapse, prefix-coloring, and the new-file badge — not real parity, re-opens the gap later."
  - "C (DiffCard + build the viewer-WebSocket LiveOutputCard for live output): rejected. Dan's own 2026-07-14-tool-stream-overlay-design.md explicitly FROZE the legacy viewer-WebSocket path ('The legacy LiveOutputEvent/LiveOutputSession path stays untouched'; non-goal: 'Any change to the legacy viewer-WebSocket path') and moved live output to in-band tool_stream ephemerals — which web ALREADY renders at parity (ToolStreamState append/sync/end, ToolStream tile components.tsx:779; durable tool_output blob fetch ToolOutput components.tsx:554). Building a web viewer-socket consumer would port toward deprecated code. See §2."
design_principles:
  - "UI hiding ≠ authorization — the viewer_url link is a real capability the bridge grants (HMAC-signed) or withholds (null); the client renders a link ONLY when the bridge supplied one, never fabricates or reconstructs it."
  - "Fail-visible — a missing/empty diff string renders a header-only card, not a blank; a null viewer_url renders plain filename text, not a dead link."
  - "Parse-don't-validate at the boundary — parseDiffPayload turns the untyped EventPayload bag into one typed DiffCardData shape at the render boundary; the component never re-reads raw payload keys."
  - "Data egress needs permission — the viewer link opens the bridge's configured file viewer in a new tab; the viewer re-validates the HMAC server-side, so the client adds no auth material and uses rel=noopener noreferrer (no window.opener handle, no referrer leak)."
  - "Code citations verified at write time — web file:line refs against the implementation base main (cf7646f); bridge refs by function name against Matronhq/matron-bridge index.js."
constraint: "components.tsx and client.ts must NOT be split — they stay single files. The DiffCard component + parseDiffPayload helper land INLINE in components.tsx; styles in journal.pcss; one small icon in icons.tsx."
---

# Web journal client — rich diff cards for file edits

## 1. Problem & goal

When the agent edits or writes a file, the bridge publishes a structured `diff` journal event carrying the full edit context. The web client throws almost all of it away — its `diff` case (`components.tsx:687`) is a bare dump:

```jsx
case "diff":
    return <pre className="mj_Diff">{asString(event.payload.diff, asString(event.payload.patch, JSON.stringify(event.payload, null, 2)))}</pre>;
```

This drops the **`viewer_url`** (the link that opens the *full* file Claude edited — while the signed link is valid, §8 L2 — not just the shown hunk), the filename, the `added`/`removed` counts, the `new_file` badge, and the `truncated` notice. The apple client renders all of it as a rich `DiffCard`, filename linked to the signed viewer.

Goal: reach parity with apple's `DiffCard` (Dan's spec `matron-apple docs/superpowers/specs/2026-07-14-diff-cards-design.md`) — a structured card with a filename header linking to the viewer, green/red prefix-colored diff, snippet-collapsed to 12 lines, additions/removals counts, and a new-file badge. This is the one genuine, current gap (see §2 for why the "live-output" half of the original framing is obsolete).

## 2. Scope correction: the "live-output" half is already at parity

This work was originally framed as "viewer_url file-open links **+ live_output** are dropped." Verified against the journal bridge (Matronhq/matron-bridge, `index.js`):

- `viewer_url` is emitted at **exactly one bridge site** — `buildEditDiffPayload` for diff/edit events (`generateFileLink(absPath, session.workdir)`). It is NOT attached to tool output, files, or anything else (`grep -n viewer_url index.js` → one *assignment*, inside `buildEditDiffPayload`; the only other match is the comment in `sendLiveOutputEvent` noting its deliberate absence from live output).
- Live tool output no longer uses a viewer WebSocket. `sendLiveOutputEvent` comment: *"No viewer_url / expires_at anywhere — live output rides the journal protocol."* It rides in-band `tool_stream` ephemerals + a durable `tool_output` completion (tee-log tail uploaded as a media blob).
- **Web already renders both** at parity: `ToolStream` tile (`components.tsx:779`, fed by `ToolStreamState` append/sync/end, 64KiB cap) and `ToolOutput` with `blob_ref` fetch (`components.tsx:554`).
- Apple's `LiveOutputCard` (viewer-WS) only triggers on a `tool_output` carrying `viewer_url` — which this bridge never emits — so apple falls through to the same `tool_stream` path web runs. Dan's `2026-07-14-tool-stream-overlay-design.md` froze the viewer-WS path as legacy.

**Therefore this spec covers only the diff card.** No client viewer-WebSocket, no file/tool_output open-links.

## 3. Wire contract (what the bridge sends — web already receives it)

`EventPayload` is `Record<string, unknown>` (`types.ts:55`), so the full payload already arrives on web's frames untouched; the `diff` case just ignores most keys. The payload shape (bridge `buildEditDiffPayload`; contract mirrors apple spec §2):

```json
{
  "type": "diff",
  "file_path": "/abs/path/to/file.ts",
  "display_path": "src/journal/file.ts",
  "viewer_url": "https://viewer.example.com/view?token=…",
  "tool": "Edit",
  "label": null,
  "diff": "@@ -10,3 +10,4 @@\n-old\n+new\n+added\n context",
  "added": 12,
  "removed": 3,
  "truncated": false,
  "new_file": false
}
```

- `viewer_url`: HMAC-signed link, or **`null`** when `HMAC_SECRET`/`VIEWER_BASE_URL` are unconfigured or the file-link gate denied it (`generateFileLink`). Links are **short-lived** (`LINK_EXPIRY_MS`, ~15 min default) while journal events are durable, so a card viewed long after the edit has an expired link that opens the viewer's own error page — no client handling (accepted, matches apple; §8 L2).
- `display_path`: path as typed in the tool input (relative or absolute). The card header shows its last component.
- `label`: subagent label string, `null` for main-agent edits.
- **Published at tool_use time** (`buildEditDiffPayload`), so a **denied or failed** Edit/Write still emits a diff event and renders a card — identical to the prior "✏️ Editing" message behavior. The payload carries no `denied`/`applied` field, so the card cannot show an attempted-vs-applied state (accepted, matches apple; §8 L3).
- **Legacy bare shape** `{ diff: "…" }` (older events, or any pre-rich payload): all metadata absent. Must render via the SAME path with nils → header-only-with-diff, no link/counts/badge.

## 4. Current web-client seams (verified against main cf7646f, `src/journal/`)

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
    diff: string;              // payload.diff ?? patch ?? JSON.stringify(payload) — always populated for a real event
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

- `diff`: `asString(payload.diff)`, else `asString(payload.patch)` (legacy fallback), else `JSON.stringify(payload, null, 2)` — **preserving the current renderer's FULL fallback chain** (`components.tsx:687`: `diff ?? patch ?? JSON.stringify(payload)`). A legacy `{patch:"…"}` event renders its patch; a malformed/schema-drifted payload renders its raw JSON as the diagnostic body (fail-visible — the diagnostic dump is retained, never a silent blank). So `diff` is effectively always populated for a real event; the body always renders.
- **Optional string fields** (`displayPath`, `filePath`, `tool`, `label`): presence-checked, NOT `asString` — `typeof payload.x === "string" && payload.x ? payload.x : undefined`. `asString` returns `""` on absence, which would (a) fail the §6 "all metadata undefined" acceptance and (b) break `displayPath ?? filePath` (nullish coalescing does not fall through on `""`).
- `viewerUrl`: set ONLY when `payload.viewer_url` is a non-empty string that parses via `new URL()` (**wrapped in try/catch — `new URL()` throws `TypeError` on a relative/invalid string, so any parse failure → `undefined`, never a thrown render**) with `protocol === "https:"` — otherwise `undefined` (plain filename, no link). Rejects a forged/future event injecting a relative path, `javascript:`/`data:` scheme, or non-https destination (never fabricated, parse-at-boundary, scheme-bounded). This is scheme + absolute-https bounding, **NOT an origin allowlist**: the web client never learns the viewer origin (`VIEWER_BASE_URL` is bridge-only config) and `viewer_url` is produced solely by the trusted bridge's `generateFileLink`; origin-pinning is out of scope (§8, accepted limitation L1).
- `added`/`removed`: set only when the payload value is a `number` (not coerced from strings).
- `truncated`/`newFile`: strict `payload.x === true` (NOT truthy `Boolean()` coercion) — same parse-at-boundary discipline; the bridge only ever emits real booleans.
- `filename` is derived in the component: last path component of `displayPath ?? filePath`, falling back to `"file"`.

### 5.2 `DiffCard` component (exported)

```tsx
export function DiffCard({ data }: { data: DiffCardData }): React.ReactElement
```

React `const [expanded, setExpanded] = useState(false)`.

Let `lineCount` = number of rendered diff lines (the trailing-newline-trimmed split defined under **Body**); `expandable` = `lineCount > 12`. The expand affordance is shown ONLY when `expandable` — a diff of ≤12 rendered lines has no chevron and no "more" row (nothing to expand; a dead toggle would violate the fail-visible principle).

**Header row** (`mj_DiffCard_header`):
- chevron button, rendered ONLY when `expandable` (`aria-expanded`, toggles `expanded`) — a distinct hit target
- `<FileEditIcon aria-hidden />`
- **filename**: when `data.viewerUrl` → `<a className="mj_DiffCard_filename mj_DiffCard_link" href={data.viewerUrl} target="_blank" rel="noopener noreferrer">{filename}</a>`; else a plain `<span className="mj_DiffCard_filename">{filename}</span>` (no dead link). No `stopPropagation`: the header row carries no click handler (the chevron is the sole expand trigger, a distinct hit target), so the link needs no propagation guard.
- dimmed `data.label` when present (`mj_DiffCard_label`)
- "new file" badge when `data.newFile` (`mj_DiffCard_badge`)
- `+{added}` / `−{removed}` counts (`mj_DiffCard_added` / `_removed`), each rendered only when its value is a number
- truncated marker "…" (title="diff truncated") when `data.truncated`

**Body** (`mj_DiffCard_body`, monospace):
- Lines = `data.diff` with **all** trailing newlines stripped (`data.diff.replace(/\n+$/, "")`) then split on `\n` — so a newline-terminated diff (including a hand-assembled legacy payload carrying 2+ trailing newlines, §3) does not yield a phantom trailing empty line (which would inflate `lineCount` and show a spurious "+1 more lines"). `lineCount`/`expandable` are computed from THIS trimmed array. Each line → `<div>` with a class by first char: `+`→`mj_DiffLine_add`, `-`→`mj_DiffLine_del`, `@`(`@@`)→`mj_DiffLine_hunk`, else `mj_DiffLine_ctx`.
- Collapsed (default): first **12** lines; when `expandable`, a dimmed `mj_DiffCard_more` **`<button>`** "+N more lines" — keyboard-operable, driving the same `expanded` toggle as the chevron (NOT a bare `<div onClick>`, which would be mouse-only). When not `expandable`, all lines already show and there is no "more" row. Expanded: all lines (bridge already caps at 400 — apple spec §1).
- When `data.truncated`, the last row reads "… diff truncated" (`mj_DiffCard_truncated`).

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

Per the matron-web jest convention: `journal/` subdir + **hyphen** `-test.ts` suffix, `.ts` even for a `.tsx` component, import depth `../../../src/journal/...`, run `node_modules/.bin/jest`.

Both `parseDiffPayload` and `DiffCard` are exported (§5.1/§5.2), so the test imports them directly.

- **parseDiffPayload:**
  - rich payload → full DiffCardData;
  - bare `{diff:"…"}` → diff set + `displayPath`/`filePath`/`tool`/`label` all **`undefined`** (not `""`) + truncated/newFile false;
  - **patch fallback (B1):** `{patch:"@@ …"}` with no `diff` → `diff` = the patch content (legacy events still render, not blank);
  - **diagnostic fallback (M1):** a payload with neither `diff` nor `patch` but other fields → `diff` = `JSON.stringify(payload, null, 2)` (raw payload shown as the body, not a silent blank); `truncated`/`newFile` from a non-boolean value (e.g. `"true"` string) → `false` (strict `=== true`);
  - non-number `added`/`removed` (e.g. string) → undefined;
  - `viewer_url: null` and `viewer_url: ""` → `viewerUrl` undefined;
  - **scheme guard + no-throw (M1/min1):** `viewer_url:"javascript:alert(1)"`, `"data:text/html,…"`, and a relative `"/view?token=x"` (which makes `new URL()` THROW) all → `viewerUrl` undefined without `parseDiffPayload` throwing; a valid `https://…` → set;
  - **empty-string fallthrough:** `display_path:""` with `file_path:"a/b.ts"` → filename resolves to `b.ts` (empty `displayPath` is `undefined`, so `?? filePath` fires).
- **DiffCard render (jsdom):**
  - filename = last component of `display_path` (falls back to `file_path`, then `"file"`);
  - link present iff `viewerUrl` set AND carries `target="_blank"` + `rel="noopener noreferrer"`; **guard test:** `viewer_url:null` → filename is a plain `<span>`, no `<a>` (link-capability boundary);
  - counts hidden when undefined; both shown when numbers;
  - new-file badge iff `new_file`;
  - collapsed shows ≤12 diff lines + a "more" row; expanding (chevron click) shows all;
  - **more-row (min4):** the "more" row is a `<button>` (keyboard-reachable) and clicking it also expands — parity with the chevron, not a mouse-only `<div>`;
  - **not-expandable guard:** a diff of ≤12 lines renders no chevron and no "more" row (all lines shown, no dead toggle);
  - **terminal-newline (M2):** a 12-line diff ending in `"\n"` (and one ending in `"\n\n"`) → `expandable` false, no chevron, no "more" row (all trailing empties trimmed, so `lineCount` is 12 not 13+);
  - **whitespace (B2):** a diff line with leading indentation renders inside `mj_DiffCard_body` (the class carrying `white-space: pre`) with its leading spaces preserved in `textContent`;
  - `truncated:true` → "… diff truncated" tail.

## 7. Scope closure note (on ship)

For the record, on ship: the viewer-WebSocket live-output half of the original framing is obsolete on this stack (Dan froze it per `2026-07-14-tool-stream-overlay-design.md`; `tool_stream` is the live-output plan and web is already at parity — §2); delivered scope = the structured DiffCard + `viewer_url` file-open link per apple's `2026-07-14-diff-cards-design.md`.

## 8. Out of scope (YAGNI)

- Viewer-WebSocket `LiveOutputCard` / `viewerUrlToWsUrl` (§2 — deprecated path, web already at parity via tool_stream).
- File / tool_output open-links (bridge emits `viewer_url` on `diff` only).
- Any `components.tsx` / `client.ts` split (single-file constraint, see frontmatter).
- Diff syntax highlighting beyond +/−/@@ prefix coloring (apple parity is prefix-color only).

### Accepted limitations (apple-parity — inherited from the bridge, not fixable client-side)

These are conscious accepts, matching Dan's apple `DiffCard` behavior; each is a candidate follow-up, NOT a blocker to this port:
- **L1 — viewer link is scheme-bounded, not origin-allowlisted.** The client bounds `viewer_url` to an absolute `https:` URL but cannot pin it to the viewer origin (`VIEWER_BASE_URL` is bridge-only config; the web client only talks to the journal server). `viewer_url` is produced solely by the trusted bridge (`generateFileLink`), so the residual (a forged event pointing at another https origin) requires a compromised producer. Origin-allowlisting would need the viewer origin plumbed to the client — a separate change.
- **L2 — viewer links expire (~15 min) while diff events are durable.** A diff card viewed well after its edit has an expired link that opens the viewer's error page. Apple accepts this verbatim. A "refresh expired link" flow (client requests a fresh signed URL) is a possible follow-up.
- **L3 — denied/failed edits still show a card.** Diffs publish at tool_use time and carry no applied/denied field, so a rejected edit renders a normal-looking card. Apple accepts this. Surfacing an attempted-vs-applied state needs a bridge payload change (cross-repo proposal).

## 9. Acceptance

1. A rich `diff` event renders a card: linked filename (opens the viewer in a new tab **while the signed link is valid**, §8 L2), `+N −M` counts, new-file badge when applicable, prefix-colored body collapsed to 12 lines, expandable, truncated tail when truncated.
2. A `diff` event with `viewer_url:null` renders the same card with a plain-text filename (no `<a>`).
3. A legacy bare `{diff:"…"}` event renders the diff with no link/counts/badge via the same path; a legacy `{patch:"…"}` event renders its patch; a `diff`/`patch`-less payload renders its JSON as the diagnostic body (never blank).
4. A `diff` event whose `viewer_url` is non-https / relative / `javascript:`/`data:` renders a plain-text filename (no `<a>`) — the link is **scheme-bounded to absolute https** (origin-allowlisting is out of scope, §8 L1).
5. Diff whitespace (indentation, tabs, repeated spaces) is preserved verbatim in the rendered body; a newline-terminated diff does not show a spurious "+1 more lines".
6. New unit test file passes under `node_modules/.bin/jest`; existing `components-test.ts` unaffected.
7. `components.tsx` and `client.ts` are not split; changes are inline.
