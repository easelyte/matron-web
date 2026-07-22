---
title: "Web journal client — diff-card viewer-link expiry detection"
status: draft
date: 2026-07-22
loop: 472
owner: easelyte
approach: "C — client-only detect-and-degrade: decode the viewer_url token's embedded `exp` in-browser (no secret needed to READ), and when the link is past expiry render a distinct non-link 'expired' state instead of a live hyperlink that opens the viewer's error page. No re-fetch (bridge-gated)."
rejected_alternatives:
  - "Re-fetch a fresh signed link on demand (the loop title's literal ask): BLOCKED client-side. A fresh HMAC link is minted only by the bridge's generateFileLink (HMAC_SECRET is bridge-only, index.js:328); the web client talks solely to the journal server and never the bridge, and the diff event carries no tool_use_id/file handle to reference. Re-fetch would require a NEW cross-repo bridge+journal RPC. It is OUT OF SCOPE here and NOT yet tracked by any loop (do not conflate with #473, which is a separate denied-state bridge change). Because #473's bridge work opens the same `buildEditDiffPayload` diff-event surface, re-fetch is a natural candidate to fold into that loop if pursued — but that is a future decision, not a commitment this spec makes. Real-workflow gain of re-fetch is low: opening a file link past its ~15min TTL is a history-review action, not the active-session norm."
  - "Show the raw dead link and let the viewer's error page explain it: rejected. Violates P3 fail-visible at the wrong layer — the client already knows the link is expired (exp is in the token) and should say so in place, not send the user to an opaque error page on files.easelyte.ai."
  - "A live per-card countdown / 'expires in Nm' indicator: rejected as over-built. The gain is cosmetic; the only load-bearing states are live-link vs expired-link. YAGNI."
related_principles:
  - "P3 Fail-visible — an expired link renders a distinct, explained 'expired' affordance in place, not a live hyperlink to a viewer error page nor a silently-plain filename indistinguishable from the never-had-a-link case."
  - "P33 Parse-don't-validate at the boundary — parseDiffPayload decodes the token's `exp` once into a typed `viewerUrlExp?: number` on DiffCardData; the component reads that field, never re-parses the token."
  - "P1 UI hiding ≠ authorization — expiry detection is a best-effort UX affordance only, NOT a proof. The viewer re-validates the HMAC `exp` server-side against ITS clock and remains the sole authority; client-side detection uses the browser clock and can disagree under skew (§3.2 grace). Hiding the link client-side neither grants nor withholds the real capability. We never fabricate or extend a link — we only decline to render one the client's own clock reads as past its `exp`."
  - "P35 Code-coordinate citations grep-confirmed at write time — bridge refs verified against bridge-journal @ journal-deploy (generateFileLink index.js:328, LINK_EXPIRY_MS index.js:199); web file:line refs against fork origin/main (the branch this worktree builds on)."
constraint: "components.tsx must NOT be split — matron-web stays structurally aligned with Matronhq/matron-web upstream (memory: project_matron_web_stays_dan_upstream_aligned). The expiry decode lands INLINE in parseDiffPayload + DiffCard in components.tsx; the one new style rule in journal.pcss. No bridge or journal-server changes."
unrelated_loops:
  - "#473 (diff-card denied-state) is NOT in this spec. Verified during brainstorm: the diff payload has no tool_use_id and no applied/denied field, and the denied signal lives on a separate tool_output event keyed by tool_use_id — so there is no reliable client-side join. #473 is being re-scoped to a bridge-enablement loop (add tool_use_id + denied status to diff events on the claude-matrix-bridge fork, upstream-propose to Dan) that unblocks a later thin web-render follow-up. Out of scope here."
---

# Web journal client — diff-card viewer-link expiry detection

## 1. Problem & goal

The DiffCard shipped in loop #455 renders the edited file's name as a hyperlink to the HMAC-signed viewer (`data.viewerUrl`, `components.tsx:1373`). That link is minted by the bridge with a **15-minute TTL** (`LINK_EXPIRY_MS = 15 * 60 * 1000`, `bridge-journal/index.js:199`; embedded as `exp` unix-seconds in the token, `index.js:343`). Diff **events are durable** — a card scrolled back to hours later still shows a live-looking hyperlink whose link is long dead. Clicking it navigates to the viewer's HMAC-rejection error page on `files.easelyte.ai`.

**Goal:** when the client's own clock reads the link as past its embedded `exp` (best-effort detection, not a server-authoritative proof — see clock-skew handling in §3.2), render a distinct, self-explaining "expired" state in place of the dead hyperlink — no navigation to an error page, and visibly different from the case where the bridge never supplied a link at all. The viewer server remains the sole authority on validity; this is a UX affordance that avoids the common dead-link case, not a security boundary.

**Non-goal:** re-minting a fresh link (bridge-gated — see rejected_alternatives). This spec is detection + graceful degradation only, fully client-side, no bridge/journal change.

## 2. Key facts (verified)

- **Token is readable, not just verifiable.** `viewer_url` = `${VIEWER_BASE_URL}/view?token=<payload>.<sig>` where `payload = base64url(JSON.stringify({ path, exp, workdir }))` (`index.js:344-346`). `exp` is plaintext-after-decode: the client reads it with `atob` on the base64url-normalized payload — **no HMAC secret is needed to READ `exp`** (the secret only gates *minting* a valid `sig`). We never trust this for authorization; the viewer still re-validates server-side.
- **TTL = 15 min**, overridable by the bridge env `LINK_EXPIRY_MS` — so the client must read the per-link `exp`, never hardcode 15 min.
- **Diff payload has no `expires_at` field** — the only expiry source is the token itself.
- The current parse boundary is `parseDiffPayload(payload)` (`components.tsx:1301`), which already bounds `viewer_url` to an absolute `https:` URL. Expiry decode extends this same boundary.

## 3. Design

### 3.1 Parse: decode `exp` into typed state

Extend `DiffCardData` (`components.tsx:1288`) with one field:

```ts
viewerUrlExp?: number; // unix seconds, from the token payload; undefined if unreadable
```

In `parseDiffPayload`, after the existing `viewerUrl` https-bound block, if `viewerUrl` is set, attempt to decode `exp`:

```ts
// Module-level, once per page load: distinguishes "bridge withheld a link"
// (no token param at all → expected, silent) from "a token was present but
// undecodable" (schema drift → a signal worth one console warning). Throttled
// to one warn per session so a fleet-wide token-format change is visible in a
// console without spamming N cards. See M3 / P3 (fail-visible).
let _viewerExpDecodeWarned = false;

// A legitimate bridge token is base64url(JSON{path,exp,workdir}) + '.' + sig. Its
// worst case is NOT tiny: generateFileLink embeds two full absolute paths, so with
// both near PATH_MAX the encoded token approaches ~11KB. 16384 covers that with
// margin while still bounding pathological (multi-MB) input far below any DoS size.
// The bound is applied to the RAW viewerUrl string FIRST — before new URL() — so an
// oversized durable event is rejected pre-parse (P8 Guard Boundary Inputs). Note the
// residual: parseDiffPayload's own new URL(payload.viewer_url) at components.tsx:1305
// (pre-existing #455 code, unchanged here) already parses the full string before this
// runs, so this bound protects only the work THIS function adds, not that prior parse.
const MAX_VIEWER_TOKEN_LEN = 16384;

function decodeViewerExp(viewerUrl: string): number | undefined {
    if (viewerUrl.length > MAX_VIEWER_TOKEN_LEN) return undefined; // bound raw input BEFORE any parse (silent; not a schema-drift signal)
    let token: string | null = null;
    try {
        // Defensive re-parse: in the real integration path parseDiffPayload already
        // validated this exact string with new URL() (components.tsx:1301-1309), so
        // this catch is unreachable via that caller — it future-proofs a direct call.
        token = new URL(viewerUrl).searchParams.get("token");
    } catch {
        return undefined; // malformed URL — not a token-schema signal, stay silent
    }
    if (!token) return undefined; // no token param → nothing to decode (silent)
    try {
        const payload = token.split(".")[0];
        if (!payload) throw new Error("empty token payload");
        const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
        // Range-sanity: require a POSITIVE, *1000-SAFE INTEGER exp. Integer is
        // load-bearing (not cosmetic): the render compares floor(Date.now()/1000)
        // to exp+grace, so a fractional exp (K+0.2) could leave the floored clock
        // forever below the threshold while the timer's msLeft<=0 branch writes the
        // same floored value — no state change, no re-arm, link wedged live. The
        // exp*1000 ceiling matters too: a huge-but-"integer" value (1e308 passes
        // Number.isInteger; 9e15 is a non-safe integer) makes exp*1000 lose
        // precision or become Infinity, so the clamp re-arms forever and the link
        // stays live — the exact failure this feature removes. The bridge always
        // mints a small floored-seconds exp (Math.floor(...) at index.js:343), so
        // these bounds match the producer and are defense-in-depth against a forged
        // durable event. MAX_EXP = floor(MAX_SAFE_INTEGER / 1000) keeps exp*1000 exact.
        const MAX_EXP = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
        if (!Number.isSafeInteger(json.exp) || json.exp <= 0 || json.exp > MAX_EXP) {
            throw new Error("no valid in-range integer exp");
        }
        return json.exp;
    } catch (err) {
        // A token WAS present but did not decode to a valid exp → schema-drift
        // signal. Warn once; still return undefined (degrade to live-link).
        if (!_viewerExpDecodeWarned) {
            _viewerExpDecodeWarned = true;
            console.warn("DiffCard: viewer_url token present but exp undecodable — expiry detection disabled for this token shape", err);
        }
        return undefined;
    }
}
```

**Guard the pre-existing parse too.** So the oversized-input bound actually precedes *all* parsing, add the same length gate to `parseDiffPayload`'s existing https block — change its condition from `typeof payload.viewer_url === "string" && payload.viewer_url` to also require `payload.viewer_url.length <= MAX_VIEWER_TOKEN_LEN`. Otherwise the existing `new URL(payload.viewer_url)` at `components.tsx:1305` parses an oversized string before `decodeViewerExp` is even reached (its internal length check then becomes belt-and-suspenders). One-line change to the existing guard, no restructure.

Failure taxonomy (P3 fail-visible, targeted): a **missing** token param (bridge withheld the link, or a non-token URL) yields `undefined` **silently** — that is the expected null-link path, not an anomaly. A token that is **present but undecodable** (future encoding, malformed durable event) yields `undefined` **and** emits one throttled `console.warn` — so a token-format rollout that silently disables expiry detection fleet-wide leaves a breadcrumb instead of vanishing. In **all** cases the return is `undefined`, and **`undefined` exp ⇒ treated as never-expiring ⇒ current live-link behavior preserved** — an unrecognized future token shape degrades to today's behavior, never to a permanently-expired card.

**On the token-format coupling (P26 schema-drift):** reading `exp` out of the bridge's token envelope (`<base64url(JSON{path,exp,workdir})>.<sig>`) couples this client to a bridge-private encoding, and a producer/consumer contract test would need a shared cross-repo fixture — exactly the coupling this matron-web-only spec avoids. Two facts make the runtime `console.warn` (not a schema test) the proportionate mitigation here: (1) this is a **best-effort UX affordance**, not a correctness/security boundary — the viewer re-validates authoritatively, so drift degrades to today's dead-link behavior plus a console breadcrumb, never to data loss or a false capability; (2) the token is a **weak/temporary coupling by design** — the **canonical fix is bridge-side**: `generateFileLink` already computes `exp` (`index.js:343`), so the bridge should publish `expires_at` directly on the diff payload, letting the client read `payload.expires_at` and delete `decodeViewerExp` entirely (no token parsing, no coupling). That is a bridge change and is **deferred to the #473 bridge-enablement loop**, which already opens `buildEditDiffPayload` — the natural home for it alongside `tool_use_id` + denied status. Until then, token-decode is the only client-only option, and the warn is its drift signal.

Parse-don't-validate (P33): the token is decoded at this one parse boundary — `DiffCard` reads the typed `viewerUrlExp`, never the raw URL string. Note the *lifecycle* honestly: `EventContent`'s `diff` case calls `parseDiffPayload(event.payload)` inline on every render (`components.tsx:1450`), so like the diff/added/removed fields it already extracts, the decode re-runs per render — this is the **pre-existing #455 parse pattern, not a new scaling class**. The added per-render cost is one bounded (`MAX_VIEWER_TOKEN_LEN`-capped) `atob` + `JSON.parse`; no `useMemo` / pre-parsed-event store is introduced, because that would diverge from the upstream inline-parse structure this fork must preserve (constraint above). If per-render parse cost ever becomes load-bearing, the fix is upstream (memoize the whole `parseDiffPayload` call site for all fields at once), not a local one-field special-case.

### 3.2 Render: three states, live degradation

In `DiffCard`, expiry is time-relative, so it is computed at render against a clock, not baked at parse. A small **skew grace** absorbs benign client-clock drift so a modestly-fast browser clock does not hide a link the viewer would still honor (the harmful false-expired direction — see B1 / clock-skew below):

```ts
// Client clock may run ahead of the viewer's clock; only flag expired once the
// client is CLOCK_SKEW_GRACE_SEC past exp, so a few seconds of drift against a
// 15-min TTL doesn't strip a still-valid link. The opposite direction (slow
// clock → link shown slightly past real expiry) is harmless: identical to
// today's always-live behavior, and the viewer still errors authoritatively.
const CLOCK_SKEW_GRACE_SEC = 30;

const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
const expiresAt = data.viewerUrlExp;
const expired = expiresAt !== undefined && nowSec >= expiresAt + CLOCK_SKEW_GRACE_SEC;
```

The fixed 30s grace assumes **TTL ≫ grace** (at the 15-min default, grace = 3.3% of the window). The client never reads the configured `LINK_EXPIRY_MS`, only per-link `exp`, so it cannot scale the grace to the TTL; if an operator ever set `LINK_EXPIRY_MS` below ~1 min the grace would swallow most of the validity window and expiry detection would approach a no-op. That is a documented assumption, not a defended case — sub-minute ephemeral-link TTLs are not a configuration this feature targets.

**Live-degradation timer (bounded, self-re-arming):** a card *valid at mount* that crosses `exp` while the tab stays open must flip without a user interaction. Arm a `setTimeout` for the remaining time; on fire, bump `nowSec`, which re-runs the effect and either flips to expired (no new timer) or re-arms. `nowSec` is a dependency so a clamped (see below) early fire re-arms rather than stalling. Cards already expired at mount arm no timer.

```ts
// Browsers clamp setTimeout delays to a signed 32-bit ms ceiling (~24.85 days);
// a delay above it fires immediately/early. Clamp so an absurd (non-default)
// LINK_EXPIRY_MS can't produce a bogus timer; the nowSec re-arm below then
// chains clamped waits until real expiry. (P21 platform-limit.)
const MAX_TIMEOUT_MS = 2_147_483_647;

useEffect(() => {
    if (expiresAt === undefined || expired) return; // no exp, or already expired → no timer
    const msLeft = (expiresAt + CLOCK_SKEW_GRACE_SEC) * 1000 - Date.now();
    if (msLeft <= 0) { setNowSec(Math.floor(Date.now() / 1000)); return; }
    const delay = Math.min(msLeft + 500, MAX_TIMEOUT_MS);
    const id = setTimeout(() => setNowSec(Math.floor(Date.now() / 1000)), delay);
    return () => clearTimeout(id);
}, [expiresAt, expired, nowSec]);
```

Bounding argument: for the normal 15-min TTL, exactly one timer arms and fires once (`nowSec` bump → `expired` becomes true → effect early-returns, no re-arm). For a pathological >24.85-day TTL the clamp fires early while still valid; the `nowSec` dependency re-runs the effect, which re-arms another clamped wait — a bounded chain of at most ⌈TTL / 24.85d⌉ fires, not a busy loop (each waits ~24 days). The `+ 500ms` guards against `setTimeout` firing a hair early within the ceiling. Timers are cleared on unmount/dep-change.

**Accepted limitation — mid-session wall-clock correction is not re-detected.** The timer is armed against `Date.now()` at mount; `nowSec` only updates when it fires. If the OS wall clock is corrected *forward* by minutes after arming (e.g. an NTP resync of a badly-drifted clock), the armed relative timeout does not reschedule and the card can keep a live-looking link past real expiry until the timer eventually fires. This is a conscious accept, not a fix target: it requires a specific narrow condition (clock jump while an un-viewed card sits mounted), the viewer remains authoritative (a click still errors, no false capability), and defending it would need a Page-Visibility / periodic-resync listener whose complexity is disproportionate to a rare, self-healing (next render or timer fire corrects it) cosmetic gap. The mandatory fake-timer test advances a fixed clock and deliberately does not exercise this path.

Header filename render becomes three-way (replacing the current two-way `data.viewerUrl ? <a> : <span>` at `components.tsx:1373`):

| State | Condition | Render |
|---|---|---|
| **Live link** | `viewerUrl && !expired` | `<a>` as today (target=_blank, rel=noopener noreferrer) |
| **Expired link** | `viewerUrl && expired` | `<span className="mj_DiffCard_filename mj_DiffCard_expired" title="Viewer link expired — re-open the file from a fresh edit">` + a trailing muted `<span className="mj_DiffCard_expiredNote">link expired</span>` |
| **No link** | `!viewerUrl` | `<span className="mj_DiffCard_filename">` as today |

The expired-state tooltip carries **no duration claim** — the TTL is a bridge env (`LINK_EXPIRY_MS`, overridable) the web client never sees, so any hardcoded "15 min" would silently lie under an override (per §2's read-per-link-`exp`-never-hardcode rule).

The expired state is **distinct from the no-link state** (P3 fail-visible): the user learns the link *existed and lapsed* (re-trigger the edit to view fresh), rather than being unable to tell it apart from a link that was never granted (e.g. a sensitive-path file the bridge withheld).

### 3.3 Style

One rule in `journal.pcss` beside the existing `.mj_DiffCard_link` block (`journal.pcss:1023`):

```css
.mj_DiffCard_expiredNote {
    color: var(--cpd-color-text-secondary);
    font: var(--cpd-font-body-xs-regular);
}
```

`.mj_DiffCard_expired` needs no new rule — it inherits `.mj_DiffCard_filename` weight and is deliberately NOT accent-colored (it is not actionable). Compound-class approach keeps the filename typography shared.

## 4. Testing

Extend `test/unit-tests/journal/diff-card-test.ts` (the #455 harness, `mountDiff`/`parseDiffPayload` already imported). **All cases below are REQUIRED** — each acceptance criterion in §6 maps to at least one mandatory test (P14 executable-verification, P38 body/impl/acceptance-as-one-contract):

- **parseDiffPayload decode:** a token whose payload base64url-decodes to `{exp: <future>}` ⇒ `viewerUrlExp === <future>`; a malformed/opaque token ⇒ `viewerUrlExp === undefined`; a `viewer_url` that is a bare non-token URL ⇒ `undefined`; an out-of-range `exp` (non-finite / ≤0) ⇒ `undefined` (range-sanity guard). (→ acceptance #5)
- **Live link:** future `exp` (beyond the skew grace) ⇒ header renders an `<a href>` (existing assertion still holds). (→ acceptance #2)
- **Expired link:** `exp` in the past by more than `CLOCK_SKEW_GRACE_SEC` ⇒ header renders NO `<a>`, renders the `mj_DiffCard_expired` span + `link expired` note. (→ acceptance #1)
- **No exp:** `viewer_url` present but token undecodable ⇒ live `<a>` (defensive fallback = today's behavior). (→ acceptance #5)
- **No link:** no `viewer_url` ⇒ plain filename span, no expired note, NO `mj_DiffCard_expiredNote` (regression guard on the three-way split; distinct from the expired state). (→ acceptance #3)
- **Skew grace:** `exp` a few seconds in the past but within `CLOCK_SKEW_GRACE_SEC` ⇒ still renders the live `<a>` (grace not yet crossed). (→ acceptance #2, guards the B1 fix)
- **Live-degradation flip (MANDATORY, not optional):** a `jest.useFakeTimers()` case mounts a card whose `exp` is a short interval in the future, asserts a live `<a>` at mount, then `act(() => jest.advanceTimersByTime(...))` past `exp + grace + 500ms` and asserts the card has flipped to the expired span with NO `<a>` — with no re-render triggered by anything but the internal timer. **Must restore real timers afterward** (`jest.useRealTimers()` in an `afterEach`, matching the in-repo precedent `components-test.ts:933` / `1035-1054`) — `diff-card-test.ts` has no existing timer-reset hook, so without this the fake timers leak into later tests in the file. This is the one behavior that distinguishes live degradation from a static mount-time check; acceptance #4 requires it, so its test is required, not optional. (→ acceptance #4)
- **Decode-failure warning (MANDATORY, deterministic via module isolation):** acceptance #5's `console.warn` clause needs a real assertion, but `_viewerExpDecodeWarned` is **module-scoped and consumed file-wide** (`jest.config.cjs` sets no `resetModules`) — and the range-sanity failure shares the same throttle budget as an undecodable token, so any file-order-dependent assertion is fragile. Use a **`jest.isolateModules(() => { … })`** block that re-requires the component module with a fresh flag: spy `console.warn`, exercise two silent-reject inputs (no token, oversized) asserting **zero** warns, then two decode-failure inputs (undecodable token, out-of-range `exp`) asserting **exactly one** warn total (throttle holds). This is order-independent and does not depend on the existing `token=secret` fixture's position. (→ acceptance #5 warn clause. The execution plan pins the exact isolated-module test.)

Token fixtures are built in-test with a helper that base64url-encodes `JSON.stringify({ path, exp, workdir })` and appends a dummy `.sig` — the test never needs a real HMAC because the client never verifies `sig`, only reads the payload. Compute `exp` values relative to a fixed test clock (`jest.setSystemTime` / a captured `Date.now()`), NOT wall-clock literals, so the skew-grace and flip cases are deterministic.

**Regression note on the existing "parses a rich diff payload" `toEqual` test (`diff-card-test.ts:63-89`):** its fixture `viewer_url: "https://example.test/view?token=secret"` decodes to `exp: undefined` (the `token` value `secret` has no `.`-separated JSON payload). Jest `toEqual` treats an absent property and an `undefined`-valued property as equal, so the test stays green without edit — but that pass is coincidental. Add `viewerUrlExp: undefined` explicitly to that fixture's expected object so a future change to `decodeViewerExp`'s failure-return (e.g. `undefined → null`) fails loudly at the real cause instead of silently.

## 5. Out of scope (YAGNI)

- Re-fetching / re-minting a fresh viewer link (bridge-gated; deferred).
- Any bridge or journal-server change.
- Countdown / "expires in Nm" UI.
- #473 denied-state rendering (separate bridge-enablement loop).
- Touching `viewer_url` for `tool_output` events (this spec is the `diff` card only; ToolOutput has its own `expired` handling at `components.tsx:1217`).

## 6. Acceptance

1. A diff card whose viewer link is past its token `exp` (by more than the skew grace) renders the filename as a non-link `<span>` (no `<a>` element in the header) plus a visible "link expired" note — so there is no click target that could navigate to the viewer error page. Framed on the token's embedded `exp`, not a fixed wall-clock age.
2. A fresh diff card (token `exp` in the future, or in the past but within the skew grace) renders the live hyperlink exactly as today.
3. A diff card with a bridge-withheld (null) link renders plain filename text with NO `<a>` and NO "link expired" note — visibly distinct from the expired state.
4. A card live at render flips to the expired state without a reload once its `exp` (plus grace) passes with the tab left open — exercised by the mandatory fake-timer test in §4.
5. An unrecognized / out-of-range token shape degrades to the live-link behavior, never to a stuck-expired card. Silent-reject cases (no `token` param, malformed URL, oversized token > `MAX_VIEWER_TOKEN_LEN`) emit no warning; a token that is present, in-bounds, but undecodable (bad base64/JSON, non-finite or ≤0 `exp`) emits exactly one throttled `console.warn` per page load — both asserted by the mandatory decode-failure test in §4.
6. `components.tsx` / `client.ts` unsplit; no bridge/journal diff; diff-card-test green with all §4 cases (including the mandatory live-flip test) present.
